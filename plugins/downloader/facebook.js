// .facebook / .fb — permukaan SOLO Facebook (permintaan Veo 2026-11-27,
// port plugins/downloader-facebook.js yue-bot). Resolvernya TETAP engine
// yang sama dengan .dl (lib/downloader/engines/facebook.js — port
// scraper/facebook.js yue juga): TIDAK ADA resolver duplikat di plugin
// ini, dan TIDAK ADA pemakaian API ponta yue (my.ponta.dpdns.org) —
// API key-nya berbayar dan tertanam di file yue; pemakaian sebagai
// fallback butuh keputusan pemilik dulu (cek 2026-11-27: API masih
// menjawab 200 dengan key itu, tapi key orang jangan dicomot diam-diam).
// Plugin ini HANYA gerbang awal + interaksi:
//   - Validasi antrean lewat antrean .dl yang SAMA via klaim manual: link
//     yang sedang diproses .dl/.fb — atau 60 detik setelahnya (cooldown) —
//     ditolak di sini, dan sebaliknya klaim .fb memblokir .dl untuk link
//     yang sama. Klaim manual tidak diproses pump .dl (claimNext melewati
//     manual); plugin ini memprosesnya sendiri lalu finish().
//   - Video diunduh dulu ke disk lewat engine.download (fetch biasa,
//     streaming, plafon 150 MB), dikirim dari file lokal sebagai video
//     inline (keputusan pemilik 2026-11-07), lalu folder tmp dihapus.
//   - Follow-up HD ala yue (60 detik): bila engine mengembalikan baris
//     kualitas lebih tinggi dari yang terkirim, kirim teks 'hd' (teks
//     biasa, TANPA reply — reply ke pesan bot memicu trigger Ryn, jadi
//     prompt .fb tidak boleh menyuruh 'balas', sama seperti .tt).
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { match, getInfo, download as downloadFacebookMedia } from '#lib/downloader/engines/facebook.js'
import { getDownloadQueue } from '#lib/downloader/queue.js'
import { attachEngineNotifierWithConn, reportEngineError } from '#lib/downloader/index.js'
import { ensureDir, ensureProviderDir } from '#lib/helpers/ensureDir.js'
import { reactTo, REACT } from '#lib/helpers/react.js'
import { createSessionStore } from '#lib/helpers/sessionStore.js'

// Plafon kirim WA (sama dengan maxMedia di lib/simple.js): file yang
// diunduh .fb tidak pernah melebihi ini karena langsung dikirim, bukan
// disimpan seperti .dl/.unduh.
export const FB_WA_MAX_BYTES = 150 * 1024 * 1024

// Sesi follow-up HD .fb: 60 detik, sama seperti plugin yue (bukan 30
// detik seperti .tt).
export const FB_FOLLOWUP_TTL_MS = 60 * 1000

export function createFbFollowupStore(opts = {}) {
  return createSessionStore({ ttlMs: FB_FOLLOWUP_TTL_MS, ...opts })
}

/** Singleton dipakai plugin .fb. */
export const fbFollowup = createFbFollowupStore()

// Pilih baris HD dari alternates engine: kualitas angka tertinggi yang
// melampaui kualitas terkirim ('720p' -> 720). Baris berlabel HD tanpa
// angka diterima bila yang terkirim bukan HD. Tanpa kandidat -> null
// (tidak ada tawaran HD, sama seperti plugin yue bila hanya ada SD).
export function pickHdAlternate(info) {
  const num = q => { const m = String(q ?? '').match(/(\d+)/); return m ? Number(m[1]) : 0 }
  const chosenNum = num(info?.quality)
  const chosenHd = /hd/i.test(String(info?.quality ?? ''))
  const better = (info?.alternates ?? []).filter(a => a?.downloadUrl)
    .filter(a => num(a.quality) > chosenNum || (!chosenHd && /hd/i.test(String(a.quality ?? ''))))
  if (!better.length) return null
  better.sort((a, b) => num(b.quality) - num(a.quality))
  return better[0]
}

function projectRoot() {
  const pluginsRoot = global.pluginLoader?.root
  return pluginsRoot ? path.resolve(pluginsRoot, '..') : process.cwd()
}

// Unduh satu URL media resolver ke folder tmp di bawah src/downloads/
// (gitignored, seperti .dl) lalu kembalikan hasil engine.download.
// Folder tmp dihapus pemanggil setelah sendFile selesai — baik sukses
// maupun gagal kirim — supaya tidak menumpuk.
async function downloadMediaToTmp(url, waFileName, root) {
  const providerDir = await ensureProviderDir(root, 'facebook')
  const dir = path.join(providerDir, `fb-${Date.now()}-${randomUUID().slice(0, 8)}`)
  await ensureDir(dir)
  try {
    const baseName = path.parse(waFileName).name || 'facebook'
    return await downloadFacebookMedia(url, { downloadUrl: url, fileName: waFileName }, { destDir: dir, baseName, maxBytes: FB_WA_MAX_BYTES })
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw e
  }
}

// Pengganti conn.sendFile(chat, url, ...) untuk media resolver: unduh
// dulu, kirim dari file lokal, bersihkan tmp. Video FB diniatkan
// ditonton inline (keputusan pemilik 2026-11-07): tanpa asDocument,
// seperti runJob untuk provider ini.
async function sendMediaFromUrl(conn, chat, url, waFileName, caption, quoted, root) {
  const downloaded = await downloadMediaToTmp(url, waFileName, root)
  try {
    await conn.sendFile(chat, downloaded.filePath, downloaded.fileName, caption, quoted, false, {})
  } finally {
    await fs.rm(path.dirname(downloaded.filePath), { recursive: true, force: true }).catch(() => {})
  }
}

// Hapus pesan prompt follow-up .fb (dipakai saat sesi dipakai maupun
// saat kedaluwarsa — prompt tidak boleh menggantung setelah 60 detik).
async function deleteFollowupPrompt(conn, entry) {
  if (!entry?.promptKey) return
  try { await conn.sendMessage(entry.chat, { delete: entry.promptKey }) } catch { /* pesan sudah hilang */ }
}

let handler = async (m, ctx) => {
  const { conn, text } = ctx
  attachEngineNotifierWithConn(conn)
  const queue = ctx.downloadQueue ?? getDownloadQueue(projectRoot())
  const url = (text ?? '').trim().split(/\s+/)[0] ?? ''
  if (!url || !match(url)) {
    throw '🌱 *Facebook*\n\nKirim link-nya:\n.fb <link facebook>\n\nVideo dikirim, lalu kirim *hd* untuk versi HD bila tersedia (teks biasa, tanpa reply, berlaku 60 detik).'
  }
  // Klaim manual: dedupe + batas per pengguna antrean .dl berlaku penuh.
  const { job } = await queue.enqueue({
    url,
    provider: 'facebook',
    chat: m.chat,
    sender: m.sender,
    senderName: m.pushName || m.name || '',
    userMsgKey: m.key ?? null,
    manual: true,
  })
  await reactTo(m, REACT.processing).catch(() => {})
  let status = 'done'
  try {
    const info = await getInfo(url)
    const root = projectRoot()
    await sendMediaFromUrl(conn, m.chat, info.downloadUrl, info.fileName, `🌱 *Facebook*\n\n*Kualitas:* ${info.quality ?? 'Video'}`, m, root)
    // Tawaran HD ala yue: hanya bila ada baris kualitas lebih tinggi.
    const hd = pickHdAlternate(info)
    if (hd?.downloadUrl) {
      const promptMsg = await m.reply(`Kirim *hd* untuk kualitas HD${hd.quality ? ` (${hd.quality})` : ''} (teks biasa saja, tanpa reply, berlaku 60 detik).`)
      // Sesi 60 detik: kedaluwarsa (timer) menghapus pesan prompt; kunci
      // pesan disimpan di entri supaya bisa dihapus juga saat dipakai.
      const followup = ctx.fbFollowup ?? fbFollowup
      followup.put(m.chat, m.sender, {
        chat: m.chat, hdUrl: hd.downloadUrl, quality: hd.quality ?? 'HD',
        promptKey: promptMsg?.key ?? null,
      }, entry => deleteFollowupPrompt(conn, entry))
    }
    await reactTo(m, REACT.done).catch(() => {})
  } catch (e) {
    status = 'failed'
    // Log mentah (terminal) + laporan guardian ke DM founder — bukan
    // cuma pesan generik dispatcher — supaya akar kegagalan berikutnya
    // langsung terbaca (standar error-logging downloader Veo). Pesan
    // kebijakan (string, mis. antrean penuh dari queue.enqueue) BUKAN
    // error: tidak dilaporkan ke founder (aturan Veo 2026-11-25) —
    // cukup log terminal, lalu dilempar lagi apa adanya.
    console.error('[.fb] gagal:', e)
    if (e instanceof Error) void reportEngineError({ engineId: 'facebook', phase: 'send', error: e, url }).catch(() => {})
    await reactTo(m, REACT.error).catch(() => {})
    throw e
  } finally {
    // Selesai/gagal -> keluar dari antrean + masuk cooldown 60 detik,
    // persis seperti job .dl biasa.
    await queue.finish(job.id, { status }).catch(() => {})
  }
}

// Follow-up: pesan teks 'hd' persis (bukan perintah, teks biasa —
// sengaja BUKAN reply, supaya tidak bentrok dengan trigger reply Ryn)
// dalam 60 detik setelah .fb, dari pengirim yang sama di chat yang sama.
// Reply 'hd' ke pesan bot tetap diterima (teksnya sama), tapi prompt
// tidak lagi menyuruh reply.
handler.before = async (m, ctx) => {
  if (m.fromMe) return false
  const teks = (m.text ?? '').trim().toLowerCase()
  if (teks !== 'hd') return false
  const followup = ctx.fbFollowup ?? fbFollowup
  const entry = followup.get(m.chat, m.sender)
  if (!entry) return false
  const conn = ctx.conn ?? m.conn
  const root = projectRoot()
  await reactTo(m, REACT.processing).catch(() => {})
  await sendMediaFromUrl(conn, m.chat, entry.hdUrl, 'facebook_hd.mp4', `🌱 *Facebook HD*\n\n*Kualitas:* ${entry.quality || 'HD'}`, m, root)
  await deleteFollowupPrompt(conn, entry)
  followup.delete(m.chat, m.sender)
  await reactTo(m, REACT.done).catch(() => {})
  return true
}

handler.help = ['facebook <link facebook>']
handler.tags = ['downloader']
handler.command = /^(facebook|fb)$/i
handler.limit = true
export default handler
