import path from 'node:path'
import {
  ensureEngines,
  detectProvider,
  supportedProviders,
  downloaderRegistry,
  getDownloadQueue,
  attachDownloadProcessor,
  runDownloadJob,
  providerLabel,
  attachEngineNotifierWithConn
} from '#lib/downloader/index.js'
import { reactTo, REACT } from '#lib/helpers/react.js'

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

let activeConn = null

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
  activeConn = conn
  attachEngineNotifierWithConn(conn)

  const registry = ctx.downloaderRegistry ?? downloaderRegistry
  const rootDir = projectRoot()
  const queue = ctx.downloadQueue ?? getDownloadQueue(rootDir)
  // Pasang/segarkan prosesor antrean dengan conn & registry terbaru.
  // Bidang job yang berubah setelah enqueue (khususnya kunci pesan posisi
  // antrean) dibaca ulang dari file antrean sesaat sebelum diproses, agar
  // prosesor tidak memegang salinan job yang kedaluwarsa.
  attachDownloadProcessor(async job => {
    let fresh = job
    try {
      const snap = await queue.snapshot()
      const found = snap.jobs.find(j => j.id === job.id)
      if (found) fresh = { ...job, userMsgKey: found.userMsgKey ?? job.userMsgKey, queueNoticeKey: found.queueNoticeKey ?? job.queueNoticeKey }
    } catch { /* pakai salinan job apa adanya */ }
    const getJobState = async id => {
      try { return (await queue.snapshot()).jobs.find(j => j.id === id) ?? null } catch { return null }
    }
    return runDownloadJob({ conn: activeConn, job: fresh, registry, rootDir, getJobState })
  })

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

  const { job, position, liveCount } = await queue.enqueue({
    url,
    provider: providerId,
    chat: m.chat,
    sender: m.sender,
    senderName: m.pushName || m.name || '',
    userMsgKey: m.key ?? null,
    // GoFile saja yang membuka sesi pilih interaktif saat hasilnya list
    // (lihat runJob: job.options.pickSession). Pixeldrain tetap pola
    // #item lama, provider lain tidak punya hasil list seperti ini.
    options: providerId === 'gofile' ? { pickSession: true } : undefined,
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

handler.help = ['download <link> / balas pesan berisi link', 'dl antrean', 'dl batal <id>']
handler.tags = ['downloader']
handler.command = /^(download|dl)$/i

export default handler
