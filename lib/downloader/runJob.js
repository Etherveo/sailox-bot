// lib/downloader/runJob.js
//
// Orkestrasi SATU job unduhan untuk antrean publik (.download/.dl):
//   getInfo -> KIRIM INFO DULU -> download (streaming via engine) -> kirim
//   file ke WA (bila muat) -> bersihkan folder job.
//
// Kenapa info dikirim terpisah dan lebih dulu: sebagian platform tidak
// memakai caption file untuk menyampaikan metadata (ukuran, nama, mime,
// tanggal unggah) — info itu harus sampai ke pengguna SEGERA setelah
// diketahui, tidak boleh tertahan menunggu unduhan selesai (permintaan
// pemilik, dan pola yang sama sudah dipakai .unduh).
//
// Beda kebijakan dari .unduh (founder, langsung): di sini file yang BERHASIL
// terkirim ke WA dihapus dari disk (perintah publik rawan spam — disk tidak
// boleh jadi tempat sampah), sedangkan file yang gagal terkirim / terlalu
// besar untuk WA dipertahankan dan jalurnya dilaporkan.
//
// Tiga perbaikan dari tes lapangan pemilik 2026-10-24:
//  1. Ekstensi hasil unduhan TIDAK lagi dipercaya dari header content-type
//     CDN (sering bohong/absen -> file tersimpan ".bin"). Setelah unduh,
//     byte awal file di-sniff (magic bytes) dan nama file dibetulkan.
//  2. Foto WEBP yang dikirim apa adanya lewat conn.sendFile berubah jadi
//     STICKER (aturan sendFile: ext webp -> sticker) dan stiker ukuran
//     penuh sering gagal dimuat WA. Foto webp yang akan dikirim sebagai
//     gambar dikonversi dulu ke JPEG memakai ffmpeg lokal.
//  3. Postingan multi-media (carousel Instagram, info.mediaItems dari
//     engine) tidak lagi berhenti di daftar "pilih #item": SEMUA item
//     diunduh dan dikirim — sebagai album WA bila koneksi mendukungnya
//     (pesan {album} + media ber-albumParentKey), jatuh ke kirim satu
//     per satu bila album gagal. List file biasa Pixeldrain tetap memakai
//     pola pilih-item seperti sebelumnya.
//  4. Folder GoFile (job.options.pickSession, dipasang plugin .dl) tidak
//     lagi berhenti di daftar "#item + kirim ulang .dl": prosesor membuka
//     SESI PILIH interaktif (lib/helpers/pickSession.js) — user ketik
//     angka/all/lanjut/batal sebagai teks biasa, sesi tetap buka tiap
//     pick berhasil. `all` menjalankan satu job batch (runGofileBatch):
//     sekuensial unduh -> kirim -> hapus per item, progres ditulis ke
//     record antrean tiap item supaya interupsi (restart bot) dilanjutkan
//     otomatis dari item yang belum terkirim.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileTypeFromBuffer } from 'file-type'
import { downloaderRegistry } from './registry.js'
import { DEFAULT_MAX_DOWNLOAD_BYTES } from './stream.js'
import { reportEngineError } from './guardian.js'
import { ensureDir } from '../helpers/ensureDir.js'
import { pickSessions as defaultPickSessions } from '../helpers/pickSession.js'

const execFileAsync = promisify(execFile)

export const WA_MAX_BYTES = 150 * 1024 * 1024 // plafon conn.sendFile di lib/simple.js (maxMedia)
export const MAX_MEDIA_ITEMS = 20 // carousel IG mentok 20; jangan kirim lebih dari ini dalam satu job

// Provider sosial yang responsnya dibuat senyaman mungkin (permintaan
// pemilik 2026-10-24): plugin hanya membalas react ⏳ di pesan peminta,
// lalu prosesor menggantinya jadi ✅ saat media terkirim — tanpa pesan
// info/ringkasan yang menuh-menuhin chat (kecuali bila ada kegagalan yang
// memang harus dilaporkan). Pesan posisi antrean (bila ada) dihapus
// setelah job selesai.
export const QUIET_PROVIDERS = new Set(['facebook', 'instagram', 'tiktok'])

// React pada pesan peminta (kunci pesan dibawa job.userMsgKey). Gagal
// react tidak boleh menggagalkan job. Teks '' = hapus react ⏳.
async function endReact(conn, job, emoji) {
  if (!job?.userMsgKey) return
  try { await conn.sendMessage(job.chat, { react: { text: emoji, key: job.userMsgKey } }) } catch { /* abaikan */ }
}

// Hapus pesan pemberitahuan posisi antrean setelah job selesai (bila ada).
// Kunci dibaca ulang dari antrean pada SAAT PENGHAPUSAN, bukan dari salinan
// job saat job diklaim: plugin baru menulis kunci itu setelah antrean dibuat,
// sementara klaim job bisa terjadi lebih dulu — salinan awal belum tentu
// membawanya. getJobState (bila dipasang pemanggil) mengembalikan rekaman
// job terbaru dari file antrean.
async function deleteQueueNotice(conn, job, getJobState) {
  let key = job?.queueNoticeKey ?? null
  if (typeof getJobState === 'function') {
    try { const fresh = await getJobState(job.id); if (fresh?.queueNoticeKey) key = fresh.queueNoticeKey } catch { /* pakai salinan job */ }
  }
  if (!key) return
  try { await conn.sendMessage(job.chat, { delete: key }) } catch { /* abaikan */ }
}

export const PROVIDER_LABELS = {
  kdrive: 'kDrive (Kuramanime)',
  pixeldrain: 'Pixeldrain',
  mediafire: 'MediaFire',
  mega: 'Mega',
  gdrive: 'Google Drive',
  mp4upload: 'MP4Upload',
  gofile: 'GoFile',
  sfile: 'SFile',
  videy: 'Videy',
  krakenfiles: 'KrakenFiles',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  instagram: 'Instagram',
  pinterest: 'Pinterest',
  twitter: 'Twitter/X',
}
export const providerLabel = id => PROVIDER_LABELS[id] || id

export function formatSize(bytes) {
  if (!bytes || bytes <= 0) return 'Tidak diketahui'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, val = bytes
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++ }
  return `${val.toFixed(2)} ${units[i]}`
}

function sanitizeFileName(name = '') {
  const cleaned = String(name).replace(/[\\/:*?"<>|\x00-\x1F]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150)
  return cleaned || 'file'
}

function stripKnownExtension(name = '') {
  const ext = path.extname(name)
  return ext ? name.slice(0, -ext.length) : name
}

function ensureUniqueDir(dirPath) {
  let final = dirPath, counter = 2
  while (fs.existsSync(final)) { final = `${dirPath}-${counter}`; counter++ }
  return final
}

// Warisan legacy (sama seperti .unduh): ekstensi ".xrar" dari sebagian
// provider sebenarnya RAR biasa.
async function normalizeXrarExtension(result) {
  if (!result?.fileName || !/\.xrar$/i.test(result.fileName)) return result
  const newFileName = result.fileName.replace(/\.xrar$/i, '.rar')
  const newPath = path.join(path.dirname(result.filePath), newFileName)
  await fsp.rename(result.filePath, newPath)
  return { ...result, fileName: newFileName, filePath: newPath }
}

// Betulkan ekstensi + mimetype hasil unduhan dari BYTE ASLI file (magic
// bytes), bukan dari header content-type yang bisa bohong/absen.
export async function sniffNormalizeFile(result) {
  if (!result?.filePath || !result?.fileName) return result
  let detected = null
  try {
    const fh = await fsp.open(result.filePath, 'r')
    try {
      const buf = Buffer.alloc(4100)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      detected = await fileTypeFromBuffer(buf.subarray(0, bytesRead))
    } finally { await fh.close() }
  } catch { detected = null }
  if (!detected?.ext) return result
  const currentExt = path.extname(result.fileName).slice(1).toLowerCase()
  if (currentExt === detected.ext) return { ...result, mimetype: detected.mime }
  const newFileName = `${stripKnownExtension(result.fileName)}.${detected.ext}`
  const newPath = path.join(path.dirname(result.filePath), newFileName)
  try { await fsp.rename(result.filePath, newPath) } catch { return { ...result, mimetype: detected.mime } }
  return { ...result, filePath: newPath, fileName: newFileName, mimetype: detected.mime }
}

let ffmpegOk = null
async function ffmpegAvailable() {
  if (ffmpegOk === null) {
    try { await execFileAsync('ffmpeg', ['-version'], { timeout: 10000 }); ffmpegOk = true } catch { ffmpegOk = false }
  }
  return ffmpegOk
}

// Konversi foto webp -> JPEG khusus untuk pengiriman WA (lihat header).
// Gagal/ffmpeg tidak ada -> kembalikan hasil apa adanya (tetap terkirim
// sebagai stiker oleh sendFile; lebih baik daripada tidak terkirim).
export async function convertWebpForWa(result) {
  if (result?.mimetype !== 'image/webp' || !result?.filePath) return result
  if (!(await ffmpegAvailable())) return result
  const outName = `${stripKnownExtension(result.fileName)}.jpg`
  const outPath = path.join(path.dirname(result.filePath), outName)
  try {
    await execFileAsync('ffmpeg', ['-y', '-i', result.filePath, '-frames:v', '1', outPath], { timeout: 60000 })
    await fsp.rm(result.filePath, { force: true }).catch(() => {})
    return { ...result, filePath: outPath, fileName: outName, mimetype: 'image/jpeg' }
  } catch { return result }
}

const mediaKind = result => result?.mimetype?.startsWith('image/') ? 'image' : result?.mimetype?.startsWith('video/') ? 'video' : 'other'

// Kirim hasil unduhan ke WA. Video dikirim sebagai DOKUMEN, bukan pesan
// video — perilaku yang pemilik harapkan untuk file episode (kasus GoFile
// 2026-10-25: mp4 terkirim sebagai video padahal maunya dokumen, seperti
// alur kuramanime lama). Penanda ganda (mimetype + ekstensi) supaya engine
// yang mimetype-nya longgar tetap ketangkap. Foto tetap image, audio
// tetap audio. Alur album IG tidak lewat sini (dokumen tidak bisa masuk
// album) dan .tt tidak tersentuh (video TikTok memang diniatkan ditonton
// inline).
const VIDEO_EXTS = new Set(['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v'])
function sendDownloadFile(conn, chat, result, caption) {
  const ext = String(result?.fileName || '').split('.').pop()?.toLowerCase()
  const asDocument = String(result?.mimetype || '').startsWith('video/') || VIDEO_EXTS.has(ext)
  return conn.sendFile(chat, result.filePath, result.fileName, caption, undefined, false, asDocument ? { asDocument: true } : {})
}

export async function runDownloadJob({ conn, job, registry = downloaderRegistry, rootDir, waMaxBytes = WA_MAX_BYTES, maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES, getJobState = null, updateJob = null, pickStore = defaultPickSessions } = {}) {
  if (!conn) { const e = new Error('Belum ada koneksi WhatsApp untuk memproses antrean.'); e.code = 'NO_CONN'; throw e }
  const engine = registry.getEngine(job.provider)
  if (!engine) throw new Error(`Engine "${job.provider}" sedang tidak aktif.`)
  const quiet = QUIET_PROVIDERS.has(job.provider)
  // Job pick sesi ikut memakai react + hapus notice seperti provider
  // quiet (pesan peminta = pesan angka/all yang diketik user).
  const reactable = quiet || job.sessionPick

  // Job batch (unduh-semua dari sesi pilih): lewati getInfo list, langsung
  // ke loop per item.
  if (job.batch) {
    return runGofileBatch({ conn, job, engine, rootDir, waMaxBytes, maxBytes, getJobState, updateJob, pickStore })
  }

  let info
  try {
    info = await engine.getInfo(job.url)
  } catch (e) {
    void reportEngineError({ engineId: job.provider, phase: 'getInfo', error: e, url: job.url })
    if (reactable) {
      await endReact(conn, job, '❌')
      await deleteQueueNotice(conn, job, getJobState)
      await conn.sendMessage(job.chat, { text: `❌ *Unduhan #${job.id} gagal*\n${e.message || e}` }).catch(() => {})
    }
    throw e
  }

  // Postingan multi-media (carousel): unduh & kirim SEMUA item.
  if (info?.isList && !info.fileUrl && Array.isArray(info.mediaItems) && info.mediaItems.length > 1) {
    return runMediaBatch({ conn, job, engine, info, rootDir, waMaxBytes, maxBytes, getJobState })
  }

  // List (Pixeldrain /l/, folder GoFile): tanpa opsi pickSession,
  // tampilkan isinya, job selesai tanpa unduhan — pengguna memilih item
  // lalu mengirim ulang link #item=n (pola lama, dipertahankan untuk
  // Pixeldrain). Dengan opsi pickSession (saat ini: GoFile dari .dl),
  // buka SESI PILIH interaktif sebagai gantinya: user ketik angka/all/
  // lanjut/batal sebagai teks biasa, tanpa kirim ulang link.
  //
  // Syarat cabang ini harus BENTUK LIST, bukan sekadar flag isList:
  // info item terpilih dari list juga membawa isList + itemIndex (untuk
  // baris "Item ke-N dari M" di pesan info single flow), tapi TIDAK
  // membawa array files. Pixeldrain menandainya dengan fileUrl, GoFile
  // dengan downloadUrl — keduanya harus lolos dari cabang ini, kalau
  // tidak info.files undefined dan prosesor jatuh diam-diam (regresi
  // 2026-10-25: .dl gofile #item=1 antre lalu hilang tanpa pesan).
  if (info?.isList && !info.fileUrl && !info.downloadUrl) {
    if (job.options?.pickSession) {
      const items = info.files.map(f => ({ fileName: f.fileName, size: f.size ?? null }))
      pickStore.put(job.chat, job.sender, {
        provider: job.provider,
        baseUrl: String(job.url).split('#')[0],
        title: info.fileName || 'Folder',
        items,
        lastBatch: null,
      })
      const shown = items.slice(0, 50)
      const lines = shown.map((f, i) => `${i + 1}. ${f.fileName} — ${formatSize(f.size)}${(f.size ?? 0) > waMaxBytes ? ' ⚠️ melebihi batas WA' : ''}`)
      if (items.length > shown.length) lines.push(`…dan ${items.length - shown.length} file lagi`)
      await conn.sendMessage(job.chat, {
        text: `📂 *Isi ${providerLabel(job.provider)}: ${info.fileName}*\nTotal: ${items.length} file — ${formatSize(info.size)}\n\n${lines.join('\n')}\n\nKetik nomornya aja (teks biasa, tanpa reply) buat unduh satu file — sesi tetap buka, jadi bisa pilih berkali-kali.\nKetik *all* buat unduh semua (satu per satu), *lanjut* buat mengulang yang gagal, *batal* buat tutup sesi. Sesi berlaku 15 menit.`
      })
      return { kind: 'list' }
    }
    const shown = info.files.slice(0, 50)
    const lines = shown.map((f, i) => `${i + 1}. ${f.fileName} — ${formatSize(f.size)}`)
    if (info.files.length > shown.length) lines.push(`…dan ${info.files.length - shown.length} file lagi`)
    await conn.sendMessage(job.chat, {
      text: `📂 *Isi ${providerLabel(job.provider)}: ${info.fileName}*\nTotal: ${info.files.length} file — ${formatSize(info.size)}\n\n${lines.join('\n')}\n\nUnduh salah satu: tambahkan #item=<nomor> di akhir link, lalu kirim lagi dengan .dl`
    })
    if (quiet) { await endReact(conn, job, '✅'); await deleteQueueNotice(conn, job, getJobState) }
    return { kind: 'list' }
  }

  const providerDir = path.join(rootDir, 'src', 'downloads', job.provider)
  await ensureDir(providerDir)
  const baseName = sanitizeFileName(stripKnownExtension(info.fileName || 'file'))
  const jobDir = ensureUniqueDir(path.join(providerDir, `${baseName}-dl${job.id}`))
  await ensureDir(jobDir)
  const jobRel = path.relative(rootDir, jobDir)

  // ── INFO DIKIRIM DULU, sebelum satu byte pun diunduh ─────────────────────
  // (provider quiet: tidak ada pesan info — cukup react ⏳ di pesan peminta)
  if (!quiet) {
    const infoLines = [
      `📦 *Informasi File* — antrean #${job.id}`,
      `🌐 Provider: ${providerLabel(job.provider)}`,
      `📄 Nama: ${info.fileName || '-'}`,
      `📏 Ukuran: ${formatSize(info.size)}`,
    ]
    if (info.mimetype) infoLines.push(`🧬 Tipe: ${info.mimetype}`)
    if (info.createTime) infoLines.push(`🗓️ Diunggah: ${new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium' }).format(new Date(info.createTime * 1000))}`)
    if (info.isList && info.itemIndex) infoLines.push(`🔢 Item ke-${info.itemIndex} dari ${info.listSize} di list`)
    if (job.senderName) infoLines.push(`🙋 Diminta oleh: ${job.senderName}`)
    infoLines.push('', '⏳ Sedang mengunduh (streaming ke disk)...')
    await conn.sendMessage(job.chat, { text: infoLines.join('\n') })
  }

  // ── UNDUH ────────────────────────────────────────────────────────────────
  let result
  try {
    result = await sniffNormalizeFile(await normalizeXrarExtension(await engine.download(job.url, info, { destDir: jobDir, baseName, maxBytes })))
  } catch (e) {
    void reportEngineError({ engineId: job.provider, phase: 'download', error: e, url: job.url })
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {})
    await conn.sendMessage(job.chat, { text: `❌ *Unduhan #${job.id} gagal*\n${e.message || e}` })
    if (reactable) { await endReact(conn, job, '❌'); await deleteQueueNotice(conn, job, getJobState) }
    throw e
  }

  const stat = await fsp.stat(result.filePath).catch(() => null)
  const actualSize = stat?.size ?? result.size ?? 0
  if (actualSize > maxBytes) {
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {})
    await conn.sendMessage(job.chat, { text: `❌ *File melewati batas unduhan* (${formatSize(maxBytes)}): ${formatSize(actualSize)}. File dihapus.` })
    throw new Error(`File melewati batas unduhan: ${actualSize} byte`)
  }

  // ── KIRIM KE WA ──────────────────────────────────────────────────────────
  let sentToWa = false
  let sendFailed = false
  if (actualSize <= waMaxBytes) {
    try {
      result = await convertWebpForWa(result)
      await sendDownloadFile(conn, job.chat, result, `📄 ${result.fileName}\n🌐 ${providerLabel(job.provider)}`)
      sentToWa = true
    } catch (e) {
      sendFailed = true
      await conn.sendMessage(job.chat, { text: `⚠️ Gagal mengirim file ke WA:\n${e.message || e}\nFile tetap tersimpan di disk: ${jobRel}` })
    }
  }

  if (sentToWa) {
    // Alur publik: file sudah sampai ke pengguna -> folder job dibersihkan.
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {})
    if (reactable) await endReact(conn, job, '✅')
  } else if (!quiet) {
    await conn.sendMessage(job.chat, {
      text: `✅ *Unduhan #${job.id} selesai!*\n📄 ${result.fileName}\n📏 ${formatSize(actualSize)}\n📁 ${jobRel}` +
        (actualSize > waMaxBytes ? `\n📲 Tidak dikirim ke WA: melebihi batas ${formatSize(waMaxBytes)}. Ambil lewat panel/file manager.` : '')
    })
    // Pick sesi: kirim gagal (sendFailed) -> ❌, oversized -> ✅ (file
    // tersimpan + dilaporkan, bukan kegagalan).
    if (job.sessionPick) await endReact(conn, job, sendFailed ? '❌' : '✅')
  } else if (sendFailed) {
    // Pesan ⚠️ sudah terkirim di atas; cukup ganti react jadi ❌.
    await endReact(conn, job, '❌')
  } else {
    // Terlalu besar untuk WA: laporkan jalur seperti biasa, bersihkan ⏳.
    await endReact(conn, job, '')
    await conn.sendMessage(job.chat, {
      text: `✅ *Unduhan #${job.id} selesai!*\n📄 ${result.fileName}\n📏 ${formatSize(actualSize)}\n📁 ${jobRel}` +
        `\n📲 Tidak dikirim ke WA: melebihi batas ${formatSize(waMaxBytes)}. Ambil lewat panel/file manager.`
    })
  }
  if (reactable) await deleteQueueNotice(conn, job, getJobState)

  return { kind: 'file', fileName: result.fileName, size: actualSize }
}

// Alur postingan multi-media: semua item diunduh lebih dulu, lalu dikirim.
// Foto/video dikirim sebagai ALBUM WA bila bisa (satu pesan album + media
// ber-albumParentKey); bila pesan album gagal, media dikirim satu per satu
// seperti biasa. File non-media dikirim terpisah; yang melewati plafon WA
// hanya disimpan dan dilaporkan.
async function runMediaBatch({ conn, job, engine, info, rootDir, waMaxBytes, maxBytes, getJobState })  {
  const quiet = QUIET_PROVIDERS.has(job.provider)
  const items = info.mediaItems.slice(0, MAX_MEDIA_ITEMS)
  const providerDir = path.join(rootDir, 'src', 'downloads', job.provider)
  await ensureDir(providerDir)
  const baseName = sanitizeFileName(stripKnownExtension(info.fileName || 'postingan'))
  const jobDir = ensureUniqueDir(path.join(providerDir, `${baseName}-dl${job.id}`))
  await ensureDir(jobDir)
  const jobRel = path.relative(rootDir, jobDir)

  if (!quiet) {
    const infoLines = [
      `📦 *Informasi File* — antrean #${job.id}`,
      `🌐 Provider: ${providerLabel(job.provider)}`,
      `📄 Nama: ${info.fileName || '-'}`,
      `🗂️ Isi: ${items.length} file (foto/video)`,
    ]
    if (job.senderName) infoLines.push(`🙋 Diminta oleh: ${job.senderName}`)
    infoLines.push('', '⏳ Sedang mengunduh semua file, lalu dikirim sebagai album...')
    await conn.sendMessage(job.chat, { text: infoLines.join('\n') })
  }

  const downloaded = []
  for (const [i, item] of items.entries()) {
    const itemBase = sanitizeFileName(stripKnownExtension(item.fileName || `file-${i + 1}`))
    try {
      const r = await sniffNormalizeFile(await engine.download(job.url, item, { destDir: jobDir, baseName: itemBase, maxBytes }))
      const size = (await fsp.stat(r.filePath).catch(() => null))?.size ?? r.size ?? 0
      downloaded.push({ result: r, size, ok: true })
    } catch (e) {
      void reportEngineError({ engineId: job.provider, phase: 'download', error: e, url: job.url })
      downloaded.push({ ok: false, error: e })
    }
  }

  const okFiles = downloaded.filter(d => d.ok)
  const totalSize = okFiles.reduce((a, d) => a + (d.size ?? 0), 0)
  const albumItems = okFiles.filter(d => d.size <= waMaxBytes && mediaKind(d.result) !== 'other')
  const plainItems = okFiles.filter(d => d.size <= waMaxBytes && mediaKind(d.result) === 'other')
  const keptItems = okFiles.filter(d => d.size > waMaxBytes)
  for (const d of albumItems) if (d.result.mimetype === 'image/webp') d.result = await convertWebpForWa(d.result)

  let sent = 0
  let albumUsed = false
  if (albumItems.length) {
    let parentKey = null
    if (albumItems.length > 1) {
      try {
        const parent = await conn.sendMessage(job.chat, {
          album: {
            expectedImageCount: albumItems.filter(d => mediaKind(d.result) === 'image').length,
            expectedVideoCount: albumItems.filter(d => mediaKind(d.result) === 'video').length,
          },
        })
        parentKey = parent?.key ?? null
        albumUsed = !!parentKey
      } catch { parentKey = null }
    }
    for (const [i, d] of albumItems.entries()) {
      try {
        await conn.sendFile(job.chat, d.result.filePath, d.result.fileName, i === 0 ? `📄 ${info.fileName}\n🌐 ${providerLabel(job.provider)}` : '', undefined, false, parentKey ? { albumParentKey: parentKey } : {})
        sent++
      } catch { /* dihitung di ringkasan */ }
    }
  }
  for (const d of plainItems) {
    try { await conn.sendFile(job.chat, d.result.filePath, d.result.fileName, `📄 ${d.result.fileName}\n🌐 ${providerLabel(job.provider)}`); sent++ } catch { /* dihitung di ringkasan */ }
  }

  const failedDownloads = downloaded.length - okFiles.length
  const unsent = okFiles.length - keptItems.length - sent
  const allSent = failedDownloads === 0 && unsent === 0 && keptItems.length === 0 && sent > 0
  if (allSent) await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {})

  if (quiet && allSent) {
    // Provider quiet + semua terkirim: cukup react ✅, tanpa pesan ringkasan.
    await endReact(conn, job, '✅')
  } else {
    const lines = [
      sent > 0 || okFiles.length > 0 ? `✅ *Unduhan #${job.id} selesai!*` : `❌ *Unduhan #${job.id} gagal*`,
      `🗂️ ${sent} dari ${downloaded.length} file terkirim ke WA${albumUsed ? ' (sebagai album)' : ''} — total ${formatSize(totalSize)}`,
    ]
    if (failedDownloads) lines.push(`⚠️ ${failedDownloads} file gagal diunduh.`)
    if (unsent > 0) lines.push(`⚠️ ${unsent} file gagal dikirim ke WA.`)
    if (keptItems.length) lines.push(`📲 ${keptItems.length} file melebihi batas WA ${formatSize(waMaxBytes)} — hanya disimpan.`)
    if (!allSent && okFiles.length) lines.push(`📁 Tersimpan di: ${jobRel}`)
    await conn.sendMessage(job.chat, { text: lines.join('\n') })
    if (quiet) await endReact(conn, job, '❌')
  }
  await deleteQueueNotice(conn, job, getJobState)

  return { kind: 'media-batch', fileName: info.fileName, size: totalSize }
}

// ─── Job batch: unduh-semua dari sesi pilih ────────────────────────────────
// Satu job, N item, sekuensial: getInfo #item -> unduh -> kirim -> hapus.
// Progres (done/failed/kept, berisi INDEX ASLI item di folder) ditulis ke
// record antrean lewat updateJob tiap item selesai — jadi restart bot di
// tengah jalan tidak mengulang item yang sudah terkirim: pump memulihkan
// job active -> pending, dan loop melewati index yang sudah done/kept.
// Item yang gagal (getInfo/unduhan) dicoba lagi pada proses berikutnya
// (resume otomatis) atau lewat perintah `lanjut` dari sesi.
// Item oversized / gagal kirim TIDAK dihapus dari disk — jalurnya dilaporkan
// di ringkasan (sama seperti kebijakan file tunggal publik).
async function runGofileBatch({ conn, job, engine, rootDir, waMaxBytes, maxBytes, getJobState, updateJob, pickStore }) {
  const baseUrl = String(job.url).split('#')[0]
  const items = Array.isArray(job.batch?.items) ? job.batch.items : []
  const progress = {
    done: [...(job.batch?.progress?.done ?? [])],
    failed: [...(job.batch?.progress?.failed ?? [])],
    kept: [...(job.batch?.progress?.kept ?? [])],
  }
  const providerDir = path.join(rootDir, 'src', 'downloads', job.provider)
  await ensureDir(providerDir)
  const baseName = sanitizeFileName(stripKnownExtension(job.batch?.name || 'gofile-batch'))
  const jobDir = ensureUniqueDir(path.join(providerDir, `${baseName}-dl${job.id}`))
  await ensureDir(jobDir)
  const jobRel = path.relative(rootDir, jobDir)

  const skipped = new Set([...progress.done, ...progress.kept.map(k => k.index)])
  const byIndex = new Map(items.map((it, pos) => [it.index ?? pos, it]))
  let sent = 0
  let sentBytes = 0
  const saveProgress = async () => {
    if (typeof updateJob !== 'function') return
    try { await updateJob(job.id, { batch: { name: job.batch?.name, items, progress } }) } catch { /* progres berikutnya tetap jalan */ }
  }

  for (const [pos, item] of items.entries()) {
    const idx = item.index ?? pos
    if (skipped.has(idx)) continue
    // Percobaan ulang membersihkan jejak gagal sebelumnya.
    progress.failed = progress.failed.filter(f => f.index !== idx)
    const itemUrl = `${baseUrl}#item=${idx + 1}`
    let info
    try {
      info = await engine.getInfo(itemUrl)
    } catch (e) {
      void reportEngineError({ engineId: job.provider, phase: 'getInfo', error: e, url: itemUrl })
      progress.failed.push({ index: idx, reason: e.message || String(e) })
      await saveProgress()
      continue
    }
    const itemBase = sanitizeFileName(stripKnownExtension(info.fileName || item.fileName || `file-${idx + 1}`))
    let result
    try {
      result = await sniffNormalizeFile(await normalizeXrarExtension(await engine.download(itemUrl, info, { destDir: jobDir, baseName: itemBase, maxBytes })))
    } catch (e) {
      void reportEngineError({ engineId: job.provider, phase: 'download', error: e, url: itemUrl })
      progress.failed.push({ index: idx, reason: e.message || String(e) })
      await saveProgress()
      continue
    }
    const stat = await fsp.stat(result.filePath).catch(() => null)
    const actualSize = stat?.size ?? result.size ?? 0
    if (actualSize > maxBytes) {
      await fsp.rm(result.filePath, { force: true }).catch(() => {})
      progress.failed.push({ index: idx, reason: `melewati batas unduhan ${formatSize(maxBytes)}` })
      await saveProgress()
      continue
    }
    if (actualSize > waMaxBytes) {
      progress.kept.push({ index: idx, fileName: result.fileName, relPath: path.relative(rootDir, result.filePath), size: actualSize, reason: 'oversized' })
      await saveProgress()
      continue
    }
    try {
      result = await convertWebpForWa(result)
      await sendDownloadFile(conn, job.chat, result, `📄 ${result.fileName}\n🌐 ${providerLabel(job.provider)}`)
      await fsp.rm(result.filePath, { force: true }).catch(() => {})
      progress.done.push(idx)
      sent++
      sentBytes += actualSize
    } catch (e) {
      progress.kept.push({ index: idx, fileName: result.fileName, relPath: path.relative(rootDir, result.filePath), size: actualSize, reason: 'send-failed' })
    }
    await saveProgress()
  }

  const lines = [
    `✅ *Batch ${providerLabel(job.provider)} selesai!* — antrean #${job.id}`,
    `🗂️ ${sent} dari ${items.length} file terkirim ke WA${sentBytes ? ` — total ${formatSize(sentBytes)}` : ''}`,
  ]
  if (progress.failed.length) {
    lines.push(`⚠️ ${progress.failed.length} file gagal:`)
    for (const f of progress.failed) lines.push(`• #${f.index + 1} ${byIndex.get(f.index)?.fileName ?? ''} — ${String(f.reason).slice(0, 120)}`)
  }
  if (progress.kept.length) {
    lines.push(`📲 ${progress.kept.length} file tersimpan di disk (tidak dikirim ke WA):`)
    for (const k of progress.kept) lines.push(`• #${k.index + 1} ${k.fileName} — ${k.reason === 'oversized' ? `melebihi batas WA ${formatSize(waMaxBytes)}` : 'gagal dikirim'} — ${k.relPath}`)
  }
  if (!progress.kept.length) await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {})
  else lines.push(`📁 Folder batch: ${jobRel}`)
  await conn.sendMessage(job.chat, { text: lines.join('\n') })
  await endReact(conn, job, progress.failed.length === 0 && progress.kept.length === 0 && sent > 0 ? '✅' : '❌')
  await deleteQueueNotice(conn, job, getJobState)

  // Catat hasil ke sesi (bila masih ada) supaya `lanjut` bisa mengulang
  // item yang gagal tanpa kirim ulang link.
  try {
    const session = pickStore.get(job.chat, job.sender)
    if (session && String(session.baseUrl).split('#')[0] === baseUrl) {
      pickStore.put(job.chat, job.sender, { ...session, lastBatch: { failed: progress.failed.map(f => f.index), kept: progress.kept } })
    }
  } catch { /* sesi boleh hilang — batch tetap selesai */ }

  return { kind: 'batch', fileName: job.batch?.name ?? 'batch', size: sentBytes }
}
