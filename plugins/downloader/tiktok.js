// .tiktok / .tt — permukaan INTERAKTIF TikTok (adaptasi handler legacy
// plugins/downloader-tiktok.js). Plugin ini HANYA gerbang awal + interaksi:
//   - Validasi antrean lewat antrean .dl yang SAMA via klaim manual: link
//     yang sedang diproses .dl/.tt — atau 60 detik setelahnya (cooldown) —
//     ditolak di sini, dan sebaliknya klaim .tt memblokir .dl untuk link
//     yang sama. Klaim manual tidak diproses pump .dl (claimNext melewati
//     manual); plugin ini memprosesnya sendiri lalu finish().
//   - Resolusi memakai ENGINE yang sama dengan .dl
//     (lib/downloader/engines/tiktok.js: savetik -> tikwm) supaya selaras —
//     TIDAK ADA resolver duplikat di plugin ini.
//   - Kirim video SD + simpan follow-up 40 detik: kirim teks 'hd' / 'mp3'
//     (teks biasa, TANPA reply — reply ke pesan bot justru memicu trigger
//     Ryn, jadi prompt .tt tidak boleh lagi menyuruh 'balas').
// Foto: satu -> kirim langsung; banyak -> kirim berurutan (legacy mengirim
// album; pengirim album runJob tidak diekspor, jadi urutan adalah padanannya).
//
// PERBAIKAN 2026-10-24 (laporan live Veo: .dl untuk link yang sama jalan,
// .tt gagal dengan pesan generik dispatcher, jeda .dl->.tt > 2 menit):
// media TIDAK LAGI dikirim langsung dari URL resolver lewat conn.sendFile.
// Jalur itu lewat getFile -> fetchPublicBuffer (lib/helpers/net.js) yang
// memvalidasi DNS: di sel VM ini semua host publik dipetakan resolver
// egress ke 198.18/15, dan validasi itu menolaknya sebagai "jaringan
// privat" — jadi .tt gagal untuk SEMUA link, sementara .dl jalan karena
// engine.download memakai fetch biasa ke disk lalu sendFile dari file
// lokal. Maka .tt kini memakai jalur yang sama: unduh dulu ke disk lewat
// engine.download (fetch biasa, streaming, plafon 150 MB), kirim dari
// file lokal, lalu hapus folder tmp-nya. Berlaku juga untuk follow-up
// 'hd'/'mp3' yang dulu sama-sama sendFile dari URL. Validasi net.js
// TIDAK dilemahkan untuk menutupi ini (aturan keamanan proyek).
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { match, resolveTiktok, download as downloadTiktokMedia } from '#lib/downloader/engines/tiktok.js'
import { getDownloadQueue } from '#lib/downloader/queue.js'
import { attachEngineNotifierWithConn, reportEngineError } from '#lib/downloader/index.js'
import { ensureDir } from '#lib/helpers/ensureDir.js'
import { reactTo, REACT } from '#lib/helpers/react.js'
import { tiktokFollowup } from '#lib/helpers/tiktokFollowup.js'

// Plafon kirim WA (sama dengan maxMedia di lib/simple.js): file yang
// diunduh .tt tidak pernah melebihi ini karena langsung dikirim, bukan
// disimpan seperti .dl/.unduh.
export const TT_WA_MAX_BYTES = 150 * 1024 * 1024

function projectRoot() {
  const pluginsRoot = global.pluginLoader?.root
  return pluginsRoot ? path.resolve(pluginsRoot, '..') : process.cwd()
}

// Unduh satu URL media resolver ke folder tmp di bawah src/downloads/
// (gitignored, seperti .dl) lalu kembalikan hasil engine.download.
// Folder tmp dihapus pemanggil setelah sendFile selesai — baik sukses
// maupun gagal kirim — supaya tidak menumpuk.
async function downloadMediaToTmp(url, waFileName, root) {
  const dir = path.join(root, 'src', 'downloads', 'tiktok', `tt-${Date.now()}-${randomUUID().slice(0, 8)}`)
  await ensureDir(dir)
  try {
    const baseName = path.parse(waFileName).name || 'tiktok'
    return await downloadTiktokMedia(url, { downloadUrl: url, fileName: waFileName }, { destDir: dir, baseName, maxBytes: TT_WA_MAX_BYTES })
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw e
  }
}

// Pengganti conn.sendFile(chat, url, ...) untuk media resolver: unduh
// dulu, kirim dari file lokal, bersihkan tmp. Argumen quoted diteruskan
// apa adanya ke sendFile (pesan peminta / pesan 'hd' penindak).
async function sendMediaFromUrl(conn, chat, url, waFileName, caption, quoted, root) {
  const downloaded = await downloadMediaToTmp(url, waFileName, root)
  try {
    await conn.sendFile(chat, downloaded.filePath, waFileName, caption, quoted)
  } finally {
    await fs.rm(path.dirname(downloaded.filePath), { recursive: true, force: true }).catch(() => {})
  }
}

let handler = async (m, ctx) => {
  const { conn, text } = ctx
  attachEngineNotifierWithConn(conn)
  const queue = ctx.downloadQueue ?? getDownloadQueue(projectRoot())
  const url = (text ?? '').trim().split(/\s+/)[0] ?? ''
  if (!url || !match(url)) {
    throw '📹 *TikTok interaktif*\n\nKirim link-nya:\n.tt <link tiktok>\n\nVideo SD dikirim, lalu kirim *hd* untuk versi HD atau *mp3* untuk audionya (teks biasa, tanpa reply, berlaku 40 detik).'
  }
  // Klaim manual: dedupe + batas per pengguna antrean .dl berlaku penuh.
  const { job } = await queue.enqueue({
    url,
    provider: 'tiktok',
    chat: m.chat,
    sender: m.sender,
    senderName: m.pushName || m.name || '',
    userMsgKey: m.key ?? null,
    manual: true,
  })
  await reactTo(m, REACT.processing).catch(() => {})
  let status = 'done'
  try {
    const res = await resolveTiktok(url)
    const root = projectRoot()
    if (res.images?.length) {
      if (res.images.length === 1) {
        await sendMediaFromUrl(conn, m.chat, res.images[0], 'tiktok-1.jpg', `🖼️ ${res.title}`, m, root)
      } else {
        for (let i = 0; i < res.images.length; i++) {
          await sendMediaFromUrl(conn, m.chat, res.images[i], `tiktok-${i + 1}.jpg`, i === 0 ? `🖼️ ${res.title}` : '', m, root)
        }
      }
      await reactTo(m, REACT.done).catch(() => {})
      return
    }
    const video = res.videoSD || res.videoHD
    if (!video) throw new Error('Resolver TikTok tidak mengembalikan media.')
    await sendMediaFromUrl(conn, m.chat, video, 'tiktok.mp4', `📹 *${res.title}*`, m, root)
    tiktokFollowup.put(m.chat, m.sender, { videoHD: res.videoHD, audio: res.audio, title: res.title })
    await m.reply("Kirim *hd* untuk versi HD atau *mp3* untuk audionya (teks biasa saja, tanpa reply, berlaku 40 detik).")
    await reactTo(m, REACT.done).catch(() => {})
  } catch (e) {
    status = 'failed'
    // Log mentah (terminal) + laporan guardian ke DM founder — bukan
    // cuma pesan generik dispatcher — supaya akar kegagalan berikutnya
    // langsung terbaca (standar error-logging downloader Veo).
    console.error('[.tt] gagal:', e)
    void reportEngineError({ engineId: 'tiktok', phase: 'send', error: e, url }).catch(() => {})
    await reactTo(m, REACT.error).catch(() => {})
    throw e
  } finally {
    // Selesai/gagal -> keluar dari antrean + masuk cooldown 60 detik,
    // persis seperti job .dl biasa.
    await queue.finish(job.id, { status }).catch(() => {})
  }
}

// Follow-up: pesan teks 'hd' / 'mp3' / 'audio' persis (bukan perintah,
// teks biasa — sengaja BUKAN reply, supaya tidak bentrok dengan trigger
// reply Ryn) dalam 40 detik setelah .tt, dari pengirim yang sama di chat
// yang sama. Reply 'hd' ke pesan bot tetap diterima (teksnya sama), tapi
// prompt tidak lagi menyuruh reply.
handler.before = async (m, ctx) => {
  if (m.fromMe) return false
  const teks = (m.text ?? '').trim().toLowerCase()
  if (teks !== 'hd' && teks !== 'mp3' && teks !== 'audio') return false
  const entry = tiktokFollowup.get(m.chat, m.sender)
  if (!entry) return false
  const conn = ctx.conn ?? m.conn
  const root = projectRoot()
  if (teks === 'hd') {
    if (!entry.videoHD) { await m.reply('HD tidak tersedia'); return true }
    await reactTo(m, REACT.processing).catch(() => {})
    await sendMediaFromUrl(conn, m.chat, entry.videoHD, 'tiktok_hd.mp4', `🎥 ${entry.title}`, m, root)
    tiktokFollowup.delete(m.chat, m.sender)
    await reactTo(m, REACT.done).catch(() => {})
    return true
  }
  if (!entry.audio) { await m.reply('Audio tidak tersedia'); return true }
  await reactTo(m, REACT.processing).catch(() => {})
  await sendMediaFromUrl(conn, m.chat, entry.audio, `${entry.title.slice(0, 100)}.mp3`, '', m, root)
  tiktokFollowup.delete(m.chat, m.sender)
  await reactTo(m, REACT.done).catch(() => {})
  return true
}

handler.help = ['tiktok <link tiktok>']
handler.tags = ['downloader']
handler.command = /^(tiktok|tt)$/i
export default handler
