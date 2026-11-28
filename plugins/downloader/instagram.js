// .instagram / .ig — permukaan SOLO Instagram (permintaan Veo 2026-11-27,
// port plugins/downloader-ig.js yue-bot). Plugin ini HANYA gerbang awal:
//   - Validasi antrean lewat antrean .dl yang SAMA via klaim manual: link
//     yang sedang diproses .dl/.ig — atau 60 detik setelahnya (cooldown) —
//     ditolak di sini, dan sebaliknya klaim .ig memblokir .dl untuk link
//     yang sama. Klaim manual tidak diproses pump .dl (claimNext melewati
//     manual); plugin ini memprosesnya sendiri lalu finish().
//   - Resolusi memakai ENGINE yang sama dengan .dl
//     (lib/downloader/engines/instagram.js: instatiktok -> fallback
//     downloadgram port yue) supaya selaras — TIDAK ADA resolver duplikat
//     di plugin ini.
//   - Media diunduh dulu ke disk lewat engine.download (fetch biasa,
//     streaming, plafon 150 MB), dikirim dari file lokal, lalu folder tmp
//     dihapus — video sebagai video inline, foto sebagai image (keputusan
//     pemilik 2026-11-07). Multi-media (carousel/album) dikirim berurutan
//     (pengirim album runJob tidak diekspor — padanan yang sama seperti
//     .tt).
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { match, getInfo, download as downloadInstagramMedia } from '#lib/downloader/engines/instagram.js'
import { getDownloadQueue } from '#lib/downloader/queue.js'
import { attachEngineNotifierWithConn, reportEngineError } from '#lib/downloader/index.js'
import { ensureDir, ensureProviderDir } from '#lib/helpers/ensureDir.js'
import { reactTo, REACT } from '#lib/helpers/react.js'

// Plafon kirim WA (sama dengan maxMedia di lib/simple.js): file yang
// diunduh .ig tidak pernah melebihi ini karena langsung dikirim, bukan
// disimpan seperti .dl/.unduh.
export const IG_WA_MAX_BYTES = 150 * 1024 * 1024

export const IG_CAPTION = '📸 *Instagram*'

function projectRoot() {
  const pluginsRoot = global.pluginLoader?.root
  return pluginsRoot ? path.resolve(pluginsRoot, '..') : process.cwd()
}

// Unduh satu URL media resolver ke folder tmp di bawah src/downloads/
// (gitignored, seperti .dl) lalu kembalikan hasil engine.download.
// Folder tmp dihapus pemanggil setelah sendFile selesai — baik sukses
// maupun gagal kirim — supaya tidak menumpuk.
async function downloadMediaToTmp(url, waFileName, root) {
  const providerDir = await ensureProviderDir(root, 'instagram')
  const dir = path.join(providerDir, `ig-${Date.now()}-${randomUUID().slice(0, 8)}`)
  await ensureDir(dir)
  try {
    const baseName = path.parse(waFileName).name || 'instagram'
    return await downloadInstagramMedia(url, { downloadUrl: url, fileName: waFileName }, { destDir: dir, baseName, maxBytes: IG_WA_MAX_BYTES })
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw e
  }
}

// Pengganti conn.sendFile(chat, url, ...) untuk media resolver: unduh
// dulu, kirim dari file lokal, bersihkan tmp. Video IG diniatkan
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

let handler = async (m, ctx) => {
  const { conn, text } = ctx
  attachEngineNotifierWithConn(conn)
  const queue = ctx.downloadQueue ?? getDownloadQueue(projectRoot())
  const url = (text ?? '').trim().split(/\s+/)[0] ?? ''
  if (!url || !match(url)) {
    throw '📸 *Instagram*\n\nKirim link-nya:\n.ig <link instagram>\n\nPostingan, reel, atau carousel — semua medianya dikirim.'
  }
  // Klaim manual: dedupe + batas per pengguna antrean .dl berlaku penuh.
  const { job } = await queue.enqueue({
    url,
    provider: 'instagram',
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
    const items = info.mediaItems?.length
      ? info.mediaItems
      : [{ fileName: info.fileName, downloadUrl: info.downloadUrl }]
    for (let i = 0; i < items.length; i++) {
      await sendMediaFromUrl(conn, m.chat, items[i].downloadUrl, items[i].fileName, i === 0 ? IG_CAPTION : '', m, root)
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
    console.error('[.ig] gagal:', e)
    if (e instanceof Error) void reportEngineError({ engineId: 'instagram', phase: 'send', error: e, url }).catch(() => {})
    await reactTo(m, REACT.error).catch(() => {})
    throw e
  } finally {
    // Selesai/gagal -> keluar dari antrean + masuk cooldown 60 detik,
    // persis seperti job .dl biasa.
    await queue.finish(job.id, { status }).catch(() => {})
  }
}

handler.help = ['instagram <link instagram>']
handler.tags = ['downloader']
handler.command = /^(instagram|ig)$/i
handler.limit = true
export default handler
