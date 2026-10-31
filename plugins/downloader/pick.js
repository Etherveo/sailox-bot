// plugins/downloader/pick.js
//
// Hook pilih interaktif untuk sesi list GoFile (lihat
// lib/helpers/pickSession.js dan lib/downloader/runJob.js).
//
// Plugin tanpa perintah: hanya handler.before yang bekerja. Pesan teks biasa dari pembuka sesi di chat
// yang sama, selama sesinya buka:
//   - angka (1..N)  -> antrekan item itu sebagai job #item (sesi tetap buka)
//   - all / semua   -> satu job batch unduh-semua (sekuensial)
//   - lanjut        -> laporkan batch yang masih berjalan, atau antrekan
//                      ulang item yang gagal dari batch terakhir sesi
//   - batal         -> tutup sesi
// Pesan lain, pesan dari bot sendiri, dan chat tanpa sesi buka dilewati
// begitu saja (return false) — tidak mengganggu perintah atau obrolan
// biasa. Pick yang masuk antrean adalah job sessionPick: melewati cooldown
// 60 detik (boleh pilih ulang) tapi tetap kena dedupe saat mengantri dan
// batas per pengguna, jadi spam pick berubah menjadi antrean berurutan.

import path from 'node:path'
import { getDownloadQueue } from '#lib/downloader/queue.js'
import { pickSessions } from '#lib/helpers/pickSession.js'
import { reactTo, REACT } from '#lib/helpers/react.js'

let handler = async () => {}
handler.help = []
handler.tags = ['downloader']

function projectRoot(ctx) {
  // Sama seperti plugins/downloader/download.js: root loader = folder
  // plugins, jadi naik satu tingkat = root project bot.
  if (global.pluginLoader?.root) return path.resolve(global.pluginLoader.root, '..')
  if (ctx?.__dirname) return path.resolve(ctx.__dirname, '..', '..')
  return process.cwd()
}

function stripFragment(url) {
  return String(url).split('#')[0]
}

handler.before = async (m, ctx) => {
  if (m.fromMe) return false
  const text = (m.text ?? '').trim()
  if (!text) return false
  const lower = text.toLowerCase()
  const isPick = /^\d+$/.test(text) || lower === 'all' || lower === 'semua' || lower === 'lanjut' || lower === 'batal'
  if (!isPick) return false
  const store = ctx?.pickSessions ?? pickSessions
  const session = store.get(m.chat, m.sender)
  if (!session) return false

  const conn = ctx?.conn ?? m.conn
  const queue = ctx?.downloadQueue ?? getDownloadQueue(projectRoot(ctx))
  const baseUrl = stripFragment(session.baseUrl)

  // Antrekan satu pick; penolakan antrean (penuh/dedupe) dibalas apa
  // adanya karena pesannya memang dirancang untuk pengguna.
  const enqueuePick = async (url, extra = {}) => {
    try {
      const { job, position, liveCount } = await queue.enqueue({
        url,
        provider: session.provider,
        chat: m.chat,
        sender: m.sender,
        senderName: m.pushName || m.name || '',
        userMsgKey: m.key ?? null,
        sessionPick: true,
        ...extra,
      })
      await reactTo(m, REACT.processing).catch(() => {})
      if (liveCount > 1) {
        const notice = await conn.sendMessage(m.chat, { text: `📍 Posisi antrean: ${position}` })
        if (notice?.key && queue.updateNotice) await queue.updateNotice(job.id, notice.key).catch(() => {})
      }
      return job
    } catch (e) {
      await m.reply(`❌ ${e.message || e}`)
      return null
    }
  }

  if (/^\d+$/.test(text)) {
    const n = Number(text)
    if (n < 1 || n > session.items.length) {
      await m.reply(`Nomor di luar daftar (1–${session.items.length}). Ketik *batal* buat tutup sesi.`)
      return true
    }
    await enqueuePick(`${baseUrl}#item=${n}`)
    store.touch(m.chat, m.sender)
    return true
  }

  if (lower === 'batal') {
    store.delete(m.chat, m.sender)
    await m.reply('Sesi pilih ditutup.')
    return true
  }

  if (lower === 'all' || lower === 'semua') {
    const items = session.items.map((f, i) => ({ index: i, fileName: f.fileName, size: f.size ?? null }))
    await enqueuePick(baseUrl, { batch: { name: session.title ?? 'gofile', items, progress: { done: [], failed: [], kept: [] } } })
    store.touch(m.chat, m.sender)
    return true
  }

  // lanjut
  const snap = await queue.snapshot()
  const live = snap.jobs.find(j => j.sender === m.sender && j.batch && stripFragment(j.url) === baseUrl && (j.status === 'pending' || j.status === 'active'))
  if (live) {
    const p = live.batch.progress ?? { done: [], failed: [], kept: [] }
    await m.reply(`Batch masih berjalan (#${live.id}, ${live.status === 'active' ? 'sedang diunduh' : 'menunggu'}): ${p.done.length}/${live.batch.items.length} terkirim. Tunggu gilirannya, ya.`)
    return true
  }
  const failed = session.lastBatch?.failed ?? []
  if (failed.length) {
    const items = failed
      .map(i => (session.items[i] ? { index: i, fileName: session.items[i].fileName, size: session.items[i].size ?? null } : null))
      .filter(Boolean)
    if (items.length) {
      await enqueuePick(baseUrl, { batch: { name: session.title ?? 'gofile', items, progress: { done: [], failed: [], kept: [] } } })
      store.touch(m.chat, m.sender)
      return true
    }
  }
  await m.reply('Tidak ada batch yang tertunda.')
  return true
}

export default handler
