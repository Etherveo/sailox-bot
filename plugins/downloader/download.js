import path from 'node:path'
import {
  ensureEngines,
  detectProvider,
  supportedProviders,
  downloaderRegistry,
  getDownloadQueue,
  ensureJobProcessor,
  providerLabel,
  attachEngineNotifierWithConn
} from '#lib/downloader/index.js'
import { reactTo, REACT } from '#lib/helpers/react.js'
import { extractVideoId, buildYtJobUrl, getVideoQualities, VIDEO_QUALITIES, DEFAULT_VIDEO_QUALITY } from '#lib/downloader/engines/youtube.js'
import { createSessionStore } from '#lib/helpers/sessionStore.js'

// Gerbang dokumen video YouTube .dl (perintah pemilik 2026-11-14):
// flag -d, ukuran >50 MB, durasi >10 menit, atau resolusi >=720p.
// Diteruskan ke runJob sebagai job.options (lihat runJob.js).
export const YT_VIDEO_DOC_ABOVE_BYTES = 50 * 1024 * 1024
export const YT_VIDEO_DOC_ABOVE_DURATION_SEC = 10 * 60
export const YT_VIDEO_DOC_IF_RESOLUTION_AT_LEAST = 720
export const YT_RESOLUTION_TTL_MS = 30 * 1000

// Sesi pilih resolusi .dl YouTube (per chat+sender): dibuka saat .dl
// link YouTube tanpa string resolusi di teks; user membalas
// '360p'/'480p'/'720p'/'1080p' dalam 30 detik, atau timeout -> 720p.
// Pesan tawaran DIHAPUS saat sesi berakhir (dipilih maupun timeout) —
// kuncinya disimpan di entri sesi. Store di atas store sesi generik
// (lib/helpers/sessionStore.js, dipakai bersama follow-up .tt).
export function createYtResolutionStore(opts = {}) {
  return createSessionStore({ ttlMs: YT_RESOLUTION_TTL_MS, ...opts })
}
export const ytResolutionSessions = createYtResolutionStore()

// Antrekan satu job video YouTube + balasan status antrean (format sama
// dengan .dl biasa). `send` menulis balasan — m.reply untuk perintah
// langsung, conn.sendMessage untuk sesi (timeout/pilihan) yang tidak
// punya pesan peminta baru untuk di-quote.
async function enqueueYtVideoJob({ queue, chat, sender, senderName, userMsgKey, jobUrl, cleanUrl, options, note, send }) {
  const { job, position } = await queue.enqueue({
    url: jobUrl,
    provider: 'youtube',
    chat,
    sender,
    senderName: senderName ?? '',
    userMsgKey: userMsgKey ?? null,
    options,
  })
  const lines = []
  if (note) lines.push(note)
  lines.push(
    `📥 *Masuk antrean #${job.id}*`,
    `🌐 Provider: YouTube`,
    `🔗 ${cleanUrl}`,
    `📍 Posisi menunggu: ${position}`,
    '',
    'Info file akan dikirim begitu giliranmu diproses, lalu file menyusul setelah unduhan selesai.',
  )
  await send(lines.join('\n'))
  return job
}

// Provider sosial yang responsnya dibuat senyaman mungkin (permintaan
// pemilik 2026-10-24): respons pertama selalu react ⏳ di pesan peminta;
// bila antrean cuma satu (tidak ada antrean lain), TIDAK ada pesan teks
// sama sekali selain react itu; bila antrean > 1, dikirim satu pesan
// posisi antrean yang dihapus prosesor setelah media terkirim, lalu react
// diganti ✅ (lihat lib/downloader/runJob.js: QUIET_PROVIDERS).
const QUIET_PROVIDERS = new Set(['facebook', 'instagram', 'tiktok'])

// .download / .dl — permukaan PUBLIK untuk downloader (pasangan .unduh yang
// khusus founder & langsung). Semua platform adalah ENGINE di
// lib/downloader/engines/ (dikelola .saveengine); plugin ini hanya:
//   1. Menemukan link dari teks perintah ATAU dari pesan yang dibalas
//      (smart parsing: token yang diapit spasi dan lolos parse URL http(s)).
//   2. Memasukkan pekerjaan ke ANTREAN persisten berbasis file JSON
//      (lib/downloader/queue.js) — anti-spam: antrean dibatasi per pengguna
//      dan hanya sedikit unduhan berjalan bersamaan; sisanya diproses
//      otomatis berurutan, dan antrean selamat dari restart bot.
//   3. Menjawab status: `.dl antrean` melihat antrean, `.dl batal <id>`
//      membatalkan job menunggu milik sendiri.
//
// Info file selalu dikirim prosesor SEBELUM unduhan dimulai (lihat
// lib/downloader/runJob.js), jadi metadata platform tanpa caption tidak
// tertahan menunggu file selesai.

function projectRoot() {
  const pluginsRoot = global.pluginLoader?.root
  return pluginsRoot ? path.resolve(pluginsRoot, '..') : process.cwd()
}

/**
 * Ambil URL valid pertama dari kumpulan teks. Token dipisah spasi (link
 * memang harus diapit spasi); tanda baca pembungkus yang lazim menempel
 * (kurung, koma, titik di akhir kalimat) dibersihkan dari tepi token.
 */
export function extractDownloadUrl(...texts) {
  for (const text of texts) {
    if (!text) continue
    for (const rawToken of String(text).split(/\s+/)) {
      const token = rawToken.replace(/^[<(\[{'"“]+/, '').replace(/[>)\]}'"”,.;:!?]+$/, '')
      if (!/^https?:\/\//i.test(token)) continue
      try {
        const url = new URL(token)
        if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
      } catch { /* token bukan URL — lanjut ke token berikutnya */ }
    }
  }
  return null
}

let handler = async (m, ctx) => {
  const { conn, text, usedPrefix, command } = ctx
  await ensureEngines()
  attachEngineNotifierWithConn(conn)

  const registry = ctx.downloaderRegistry ?? downloaderRegistry
  const rootDir = projectRoot()
  const queue = ctx.downloadQueue ?? getDownloadQueue(rootDir)
  // Pasang/segarkan prosesor antrean dengan conn & registry terbaru
  // (kabelnya dipakai bersama .animedownload — lib/downloader/processor.js).
  ensureJobProcessor({ conn, queue, registry, rootDir })

  // Daftar provider dalam bentuk per baris (bukan koma) supaya mudah
  // dibaca di chat — permintaan pemilik 2026-10-25.
  const providersText = () => { const list = supportedProviders().map(providerLabel); return list.length ? list.map(l => `• ${l}`).join('\n') : '(belum ada engine aktif)' }
  const raw = (text ?? '').trim()

  // --- Sub-perintah antrean ---
  if (/^(antrean|antri|status)$/i.test(raw.split(/\s+/)[0] ?? '') && !/^https?:\/\//i.test(raw)) {
    const snap = await queue.snapshot()
    const mine = snap.jobs.filter(j => j.sender === m.sender && (j.status === 'pending' || j.status === 'active'))
    const lines = mine.map(j => `#${j.id} — ${providerLabel(j.provider)} — ${j.status === 'active' ? 'sedang diunduh' : 'menunggu'} — ${j.url}`)
    return m.reply(
      `📥 *Antrean unduhan*\nSedang berjalan: ${snap.active} • Menunggu: ${snap.pending}\n\n` +
      (lines.length ? `Antreanmu:\n${lines.join('\n')}` : 'Kamu tidak punya unduhan yang menunggu/berjalan.') +
      `\n\nBatalkan: ${usedPrefix}${command} batal <id>`
    )
  }
  if (/^batal\b/i.test(raw)) {
    const id = Number(raw.split(/\s+/)[1])
    if (!id) throw `Format: ${usedPrefix}${command} batal <id>`
    const job = await queue.cancel(id, m.sender)
    return m.reply(`🗑️ Antrean #${job.id} dibatalkan.`)
  }

  // --- Temukan link: teks perintah dulu, lalu teks pesan yang dibalas ---
  const url = extractDownloadUrl(raw, m.quoted?.text, m.quoted?.caption)
  if (!url) {
    throw (
      `📥 *Download file dari link*\n\n` +
      `Kirim link-nya langsung:\n${usedPrefix}${command} <link>\n\n` +
      `atau *balas* pesan yang berisi link dengan:\n${usedPrefix}${command}\n\n` +
      `Link dicari otomatis dari teks (harus diapit spasi).\n` +
      `Provider didukung:\n${providersText()}\n\n` +
      `Unduhan masuk antrean supaya tidak spam — cek dengan ${usedPrefix}${command} antrean.`
    )
  }

  const providerId = registry.detectProvider(url)
  if (!providerId) {
    throw `❌ Domain link ini belum didukung.\nProvider yang didukung:\n${providersText()}`
  }

  // --- YouTube: VIDEO (bukan lagi mp3) + sesi pilih resolusi ---
  // .dl link YouTube kini mengunduh video mp4 (default 720p, maks
  // 1080p). String resolusi di teks ('720p', '1080p', ...) dipakai
  // langsung; tanpa itu, dibuka sesi tawaran 30 detik (lihat bawah).
  // Gerbang dokumen (flag -d / ukuran / durasi / resolusi) diteruskan
  // ke runJob lewat job.options.
  // Pengecualian: .play mendelegasikan antrean audio ke sini dengan
  // ctx.youtubeKind === 'audio' — cabang video ini TIDAK boleh
  // membajak job audio (tanpa flag itu .play akan membuka sesi
  // tawaran resolusi dan tidak pernah antre).
  if (providerId === 'youtube' && ctx.youtubeKind !== 'audio') {
    const videoId = extractVideoId(url)
    if (!videoId) throw '❌ Link YouTube tidak valid!'
    const tokens = raw.split(/\s+/).filter(Boolean)
    const gates = {
      forceDocument: tokens.includes('-d'),
      docAboveBytes: YT_VIDEO_DOC_ABOVE_BYTES,
      docAboveDurationSec: YT_VIDEO_DOC_ABOVE_DURATION_SEC,
      docIfResolutionAtLeast: YT_VIDEO_DOC_IF_RESOLUTION_AT_LEAST,
    }
    const resMatch = raw.match(/\b(360|480|720|1080)p\b/i)
    if (resMatch) {
      return enqueueYtVideoJob({
        queue, chat: m.chat, sender: m.sender,
        senderName: m.pushName || m.name || '',
        userMsgKey: m.key ?? null,
        jobUrl: buildYtJobUrl(videoId, 'video', Number(resMatch[1])),
        cleanUrl: url, options: gates,
        send: text => m.reply(text),
      })
    }
    // Tanpa string resolusi -> tawarkan pilihan 30 detik (default 720p).
    // Resolusi yang ditawarkan dibaca dari Savetube bila bisa; gagal
    // (savetube down) -> tawarkan semua, fallback ditangani engine.
    let available = [...VIDEO_QUALITIES]
    try {
      const qualities = await (ctx.getVideoQualities ?? getVideoQualities)(url)
      if (Array.isArray(qualities) && qualities.length) available = qualities
    } catch { /* tawarkan semua */ }
    const offerText = [
      `🎬 *Pilih resolusi video*`,
      `Resolusi tersedia: ${available.map(q => q === DEFAULT_VIDEO_QUALITY ? `${q}p (default)` : `${q}p`).join(' • ')}`,
      '',
      `Kirim resolusi yang kamu mau (mis. ${DEFAULT_VIDEO_QUALITY}p) dalam 30 detik — teks biasa saja, tanpa reply.`,
      `Kalau tidak dibalas, otomatis ${DEFAULT_VIDEO_QUALITY}p.`,
    ].join('\n')
    const sent = await conn.sendMessage(m.chat, { text: offerText })
    const sessions = ctx.ytResolutionSessions ?? ytResolutionSessions
    sessions.put(m.chat, m.sender, {
      chat: m.chat, sender: m.sender, videoId, url, gates,
      offerKey: sent?.key ?? null,
      userMsgKey: m.key ?? null,
      senderName: m.pushName || m.name || '',
    }, async entry => {
      // Timeout: hapus tawaran, antrekan 720p (default).
      if (entry.offerKey) await conn.sendMessage(entry.chat, { delete: entry.offerKey }).catch(() => {})
      try {
        await enqueueYtVideoJob({
          queue, chat: entry.chat, sender: entry.sender, senderName: entry.senderName,
          userMsgKey: entry.userMsgKey,
          jobUrl: buildYtJobUrl(entry.videoId, 'video', DEFAULT_VIDEO_QUALITY),
          cleanUrl: entry.url, options: entry.gates,
          note: `⏰ Waktu memilih resolusi habis — lanjut ${DEFAULT_VIDEO_QUALITY}p (default).`,
          send: text => conn.sendMessage(entry.chat, { text }),
        })
      } catch (e) {
        await conn.sendMessage(entry.chat, { text: `❌ ${e?.message || e}` }).catch(() => {})
      }
    })
    return
  }

  // GoFile saja yang membuka sesi pilih interaktif saat hasilnya list
  // (lihat runJob: job.options.pickSession). Pixeldrain tetap pola
  // #item lama, provider lain tidak punya hasil list seperti ini.
  // Kontrak lama: job polos tanpa opsi -> options undefined (bukan {}),
  // supaya .dl biasa tidak membawa jejak opsi anime/gate.
  const jobOptions = {
    ...(providerId === 'gofile' ? { pickSession: true } : {}),
    // Gerbang job dari plugin pendelegasi (mis. .play: -d / batas
    // ukuran / durasi audio) — diteruskan apa adanya ke runJob.
    ...(ctx.jobOptions ?? {}),
  }
  const { job, position, liveCount } = await queue.enqueue({
    url,
    provider: providerId,
    chat: m.chat,
    sender: m.sender,
    senderName: m.pushName || m.name || '',
    userMsgKey: m.key ?? null,
    options: Object.keys(jobOptions).length ? jobOptions : undefined,
  })

  // Provider sosial: respons pertama = react ⏳. Antrean > 1 -> kirim satu
  // pesan posisi (dihapus prosesor setelah selesai). Antrean solo -> tidak
  // ada pesan teks sama sekali.
  if (QUIET_PROVIDERS.has(providerId)) {
    await reactTo(m, REACT.processing).catch(() => {})
    if (liveCount > 1) {
      const notice = await conn.sendMessage(m.chat, { text: `📍 Posisi antrean: ${position}` })
      if (notice?.key && queue.updateNotice) await queue.updateNotice(job.id, notice.key).catch(() => {})
    }
    return
  }

  return m.reply(
    `📥 *Masuk antrean #${job.id}*\n` +
    `🌐 Provider: ${providerLabel(providerId)}\n` +
    `🔗 ${url}\n` +
    `📍 Posisi menunggu: ${position}\n\n` +
    `Info file akan dikirim begitu giliranmu diproses, lalu file menyusul setelah unduhan selesai.`
  )
}

// Follow-up sesi resolusi .dl YouTube: balasan '360p'/'480p'/'720p'/
// '1080p' (teks biasa, tanpa reply) dari pemilik sesi di chat yang sama
// dalam 30 detik -> antrekan resolusi itu; pesan tawaran dihapus.
// Sesi sudah habis / bukan pemilik sesi -> bukan urusan plugin ini.
handler.before = async (m, ctx) => {
  if (m.fromMe) return false
  const resMatch = /^(360|480|720|1080)p$/i.exec((m.text ?? '').trim())
  if (!resMatch) return false
  const sessions = ctx.ytResolutionSessions ?? ytResolutionSessions
  const entry = sessions.get(m.chat, m.sender)
  if (!entry) return false
  const conn = ctx.conn ?? m.conn
  const queue = ctx.downloadQueue ?? getDownloadQueue(projectRoot())
  const quality = Number(resMatch[1])
  sessions.delete(m.chat, m.sender)
  if (entry.offerKey) await conn.sendMessage(m.chat, { delete: entry.offerKey }).catch(() => {})
  try {
    await enqueueYtVideoJob({
      queue, chat: m.chat, sender: m.sender,
      senderName: m.pushName || m.name || '',
      userMsgKey: m.key ?? null,
      jobUrl: buildYtJobUrl(entry.videoId, 'video', quality),
      cleanUrl: entry.url, options: entry.gates,
      send: text => conn.sendMessage(m.chat, { text }),
    })
  } catch (e) {
    await m.reply(`❌ ${e?.message || e}`).catch(() => {})
  }
  return true
}

handler.help = ['download <link> / balas pesan berisi link', 'dl antrean', 'dl batal <id>']
handler.tags = ['downloader']
handler.command = /^(download|dl)$/i
handler.bigSend = true

export default handler
