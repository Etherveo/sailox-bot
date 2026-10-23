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

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { downloaderRegistry } from './registry.js'
import { DEFAULT_MAX_DOWNLOAD_BYTES } from './stream.js'
import { reportEngineError } from './guardian.js'

export const WA_MAX_BYTES = 150 * 1024 * 1024 // plafon conn.sendFile di lib/simple.js (maxMedia)

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

export async function runDownloadJob({ conn, job, registry = downloaderRegistry, rootDir, waMaxBytes = WA_MAX_BYTES, maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES } = {}) {
  if (!conn) { const e = new Error('Belum ada koneksi WhatsApp untuk memproses antrean.'); e.code = 'NO_CONN'; throw e }
  const engine = registry.getEngine(job.provider)
  if (!engine) throw new Error(`Engine "${job.provider}" sedang tidak aktif.`)

  let info
  try {
    info = await engine.getInfo(job.url)
  } catch (e) {
    void reportEngineError({ engineId: job.provider, phase: 'getInfo', error: e, url: job.url })
    throw e
  }

  // List (Pixeldrain /l/, folder GoFile): tampilkan isinya, job selesai
  // tanpa unduhan — pengguna memilih item lalu mengirim ulang link #item=n.
  if (info?.isList && !info.fileUrl) {
    const shown = info.files.slice(0, 50)
    const lines = shown.map((f, i) => `${i + 1}. ${f.fileName} — ${formatSize(f.size)}`)
    if (info.files.length > shown.length) lines.push(`…dan ${info.files.length - shown.length} file lagi`)
    await conn.sendMessage(job.chat, {
      text: `📂 *Isi ${providerLabel(job.provider)}: ${info.fileName}*\nTotal: ${info.files.length} file — ${formatSize(info.size)}\n\n${lines.join('\n')}\n\nUnduh salah satu: tambahkan #item=<nomor> di akhir link, lalu kirim lagi dengan .dl`
    })
    return { kind: 'list' }
  }

  const providerDir = path.join(rootDir, 'src', job.provider)
  await fsp.mkdir(providerDir, { recursive: true })
  const baseName = sanitizeFileName(stripKnownExtension(info.fileName || 'file'))
  const jobDir = ensureUniqueDir(path.join(providerDir, `${baseName}-dl${job.id}`))
  await fsp.mkdir(jobDir, { recursive: true })
  const jobRel = path.relative(rootDir, jobDir)

  // ── INFO DIKIRIM DULU, sebelum satu byte pun diunduh ─────────────────────
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

  // ── UNDUH ────────────────────────────────────────────────────────────────
  let result
  try {
    result = await normalizeXrarExtension(await engine.download(job.url, info, { destDir: jobDir, baseName, maxBytes }))
  } catch (e) {
    void reportEngineError({ engineId: job.provider, phase: 'download', error: e, url: job.url })
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {})
    await conn.sendMessage(job.chat, { text: `❌ *Unduhan #${job.id} gagal*\n${e.message || e}` })
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
  if (actualSize <= waMaxBytes) {
    try {
      await conn.sendFile(job.chat, result.filePath, result.fileName, `📄 ${result.fileName}\n🌐 ${providerLabel(job.provider)}`)
      sentToWa = true
    } catch (e) {
      await conn.sendMessage(job.chat, { text: `⚠️ Gagal mengirim file ke WA:\n${e.message || e}\nFile tetap tersimpan di disk: ${jobRel}` })
    }
  }

  if (sentToWa) {
    // Alur publik: file sudah sampai ke pengguna -> folder job dibersihkan.
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {})
  } else {
    await conn.sendMessage(job.chat, {
      text: `✅ *Unduhan #${job.id} selesai!*\n📄 ${result.fileName}\n📏 ${formatSize(actualSize)}\n📁 ${jobRel}` +
        (actualSize > waMaxBytes ? `\n📲 Tidak dikirim ke WA: melebihi batas ${formatSize(waMaxBytes)}. Ambil lewat panel/file manager.` : '')
    })
  }

  return { kind: 'file', fileName: result.fileName, size: actualSize }
}
