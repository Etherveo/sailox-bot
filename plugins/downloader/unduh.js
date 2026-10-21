// plugins/downloader/unduh.js
//
// Interface controller TUNGGAL untuk semua downloader (Pixeldrain,
// MediaFire, Mega, Google Drive, MP4Upload) — diporting dari legacy
// plugins/downloader-unduh.js (command `.u` / `.unduh`). Semua logic
// per-provider ada di lib/downloader/engines/*; file ini cuma parsing
// input, feedback ke pengguna, dan orkestrasi:
//   deteksi provider -> info -> unduh ke disk -> KIRIM KE WHATSAPP
//
// Beda dari legacy (disesuaikan dengan bot ini):
//  - Pengiriman ke WA adalah fitur BARU di sini (legacy berhenti di disk +
//    backup Drive). File dikirim lewat conn.sendFile, yang di bot ini
//    berplafon 20 MB (lib/simple.js) — file lebih besar tetap diunduh ke
//    disk dan jalurnya dilaporkan, tidak dipaksakan ke WA.
//  - Argumen ke-3 dulu berarti "upload ke Drive (1/0)"; subsistem Drive
//    tidak ada di bot ini, jadi sekarang berarti "kirim ke WA (1/0)".
//  - Flag -y (auto-extract) belum didukung (belum ada subsistem ekstrak);
//    flag-nya dikenali supaya tidak mengotori parsing, lalu diabaikan
//    dengan pemberitahuan. Flag -c (cleanup) tetap berfungsi.
//  - Batas unduhan 2 GiB ditegakkan saat streaming (engine), khusus Mega
//    ditegakkan setelah unduh selesai (engine-nya warisan legacy).
//
// Pola input:
//   .unduh url | namaFileCustom (opsional, TANPA ekstensi) | kirimWA (1/0, default 1)
//   Tambahkan "-c" di paling akhir untuk hapus folder job dari disk lokal
//   setelah pengiriman WA selesai (atau setelah unduh bila kirim WA mati).
//
// Contoh:
//   .unduh https://pixeldrain.com/u/123xyz | file musik hi-res | 0
//   .unduh https://pixeldrain.com/l/abcd1234            (tampilkan isi list)
//   .unduh https://pixeldrain.com/l/abcd1234#item=2     (unduh file ke-2)

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  ensureEngines,
  detectProvider,
  getEngine,
  supportedProviders,
  DEFAULT_MAX_DOWNLOAD_BYTES,
  reportEngineError,
  attachEngineNotifierWithConn
} from '#lib/downloader/index.js'
import { isKdriveWrapperUrl } from '#lib/helpers/kdriveRelay.js'
import { preResolveKdrive, episodeCandidate } from '#lib/helpers/kdrivePreResolve.js'

const WA_MAX_BYTES = 20 * 1024 * 1024 // plafon conn.sendFile di lib/simple.js
const MAX_DOWNLOAD_BYTES = DEFAULT_MAX_DOWNLOAD_BYTES

const PROVIDER_LABELS = {
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
  twitter: 'Twitter/X'
}

function label(providerId) { return PROVIDER_LABELS[providerId] || providerId }

function sanitizeFileName(name = '') {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150)
  return cleaned || 'file'
}

function stripKnownExtension(name = '') {
  const ext = path.extname(name)
  return ext ? name.slice(0, -ext.length) : name
}

function ensureUniqueDir(dirPath) {
  let final = dirPath
  let counter = 2
  while (fs.existsSync(final)) {
    final = `${dirPath}-${counter}`
    counter++
  }
  return final
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return 'Tidak diketahui'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let val = bytes
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return `${val.toFixed(2)} ${units[i]}`
}

/**
 * Beberapa provider (kasus yang ketemu di Mega) bisa ngembaliin RAR
 * dengan ekstensi keliru ".xrar" — rename sebelum dipakai downstream
 * (warisan legacy, dipertahankan).
 */
async function normalizeXrarExtension(result) {
  if (!result?.fileName || !/\.xrar$/i.test(result.fileName)) return result
  const newFileName = result.fileName.replace(/\.xrar$/i, '.rar')
  const newPath = path.join(path.dirname(result.filePath), newFileName)
  await fsp.rename(result.filePath, newPath)
  return { ...result, fileName: newFileName, filePath: newPath }
}

/**
 * Lepas flag -y / -c di akhir teks (boleh urutan apa aja), SEBELUM
 * split('|') — pola yang sama seperti legacy.
 */
function parseTrailingFlags(input) {
  let raw = input
  const flags = new Set()
  let m
  while ((m = raw.match(/(?:^|\s)-(y|c)$/i))) {
    flags.add(m[1].toLowerCase())
    raw = raw.slice(0, m.index).trim()
  }
  return { raw, isExtractFlag: flags.has('y'), cleanupFlag: flags.has('c') }
}

function projectRoot() {
  const pluginsRoot = global.pluginLoader?.root
  return pluginsRoot ? path.resolve(pluginsRoot, '..') : process.cwd()
}

let handler = async (m, { conn, text, usedPrefix, command }) => {
  await ensureEngines()
  attachEngineNotifierWithConn(conn)

  if (!text) {
    throw (
      `📥 *Contoh penggunaan:*\n` +
      `${usedPrefix + command} https://pixeldrain.com/u/123xyz | file musik hi-res | 0\n\n` +
      `Format: url | nama file custom (opsional, JANGAN tulis ekstensi) | kirim ke WA 1/0 (default 1)\n` +
      `Tambahkan "-c" di akhir kalau mau folder job dihapus dari disk lokal setelah semuanya kelar.\n` +
      `Link list Pixeldrain (/l/) tanpa #item= menampilkan isi list-nya dulu.\n\n` +
      `Provider didukung: ${supportedProviders().map(label).join(', ')}`
    )
  }

  const { raw, isExtractFlag, cleanupFlag } = parseTrailingFlags(text.trim())

  let [urlPart, nameArg, waArg] = raw.split('|').map(s => (s !== undefined ? s.trim() : s))
  if (!urlPart) {
    throw `❌ URL tidak boleh kosong.\n\nContoh: ${usedPrefix + command} <url> | nama file | 1`
  }

  let parsedUrl
  try { parsedUrl = new URL(urlPart) } catch { throw '❌ URL tidak valid.' }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw '❌ URL harus http(s).'

  if (nameArg && nameArg.length > 150) {
    return m.reply('❌ Nama file custom maksimal 150 karakter.')
  }

  let waFlag = true
  if (waArg !== undefined && waArg !== '') {
    if (/^(0|false|tidak|no|n)$/i.test(waArg)) waFlag = false
    else if (/^(1|true|ya|yes|y)$/i.test(waArg)) waFlag = true
  }

  const providerId = detectProvider(urlPart)
  if (!providerId) {
    throw (
      `❌ Domain tidak dikenali / belum didukung.\n` +
      `Provider yang didukung: ${supportedProviders().map(label).join(', ')}`
    )
  }
  const engine = getEngine(providerId)

  // --- kDrive: URL pembungkus diresolusi DULU ke URL endpoint (engine
  // hanya memproses endpoint langsung / halaman v1). Slot nama custom
  // boleh diisi URL EPISODE asal link (kuramanime.*) sebagai konteks
  // resolusi; bila terpakai, slot nama dikosongkan. Mode direct memakai
  // resolver lokal (jalur episode), mode stranger me-relay ke bot
  // pasangan — logika lengkapnya di lib/helpers/kdrivePreResolve.js.
  if (providerId === 'kdrive' && isKdriveWrapperUrl(urlPart)) {
    const strangerRelay = globalThis.kdriveMode === 'stranger' && String(globalThis.kdrivePeer ?? '').replace(/\D/g, '')
    if (episodeCandidate(nameArg) || strangerRelay) {
      await m.reply(globalThis.kdriveMode === 'stranger'
        ? '🔗 Mode stranger: meminta resolusi link kDrive ke bot pasangan…'
        : '🔗 Me-resolusi link kDrive lewat halaman episodenya…')
      try {
        const pre = await preResolveKdrive({ conn, url: urlPart, nameArg })
        if (pre) { urlPart = pre.url; nameArg = pre.nameArg }
      } catch (e) {
        throw `❌ Resolusi kDrive gagal:\n${e.message || e}`
      }
    }
  }

  // --- Ambil metadata file (CEPAT, gak narik body file) ---
  let info
  try {
    info = await engine.getInfo(urlPart)
  } catch (e) {
    void reportEngineError({ engineId: providerId, phase: 'getInfo', error: e, url: urlPart })
    throw `❌ Gagal mengambil informasi file:\n${e.message || e}`
  }

  // --- List tanpa item terpilih (Pixeldrain /l/): tampilkan isinya saja ---
  if (info?.isList && !info.fileUrl) {
    const shown = info.files.slice(0, 50)
    const lines = shown.map((f, i) => `${i + 1}. ${f.fileName} — ${formatSize(f.size)}`)
    if (info.files.length > shown.length) lines.push(`…dan ${info.files.length - shown.length} file lagi`)
    return m.reply(
      `📂 *Isi list ${label(providerId)}: ${info.fileName}*\n` +
      `Total: ${info.files.length} file — ${formatSize(info.size)}\n\n` +
      lines.join('\n') +
      `\n\nUnduh salah satu: tambahkan #item=<nomor> di akhir link, mis.\n${usedPrefix + command} ${urlPart}#item=1`
    )
  }

  // --- Siapkan folder kerja khusus job ini di src/<provider>/ (pola legacy) ---
  const providerDir = path.join(projectRoot(), 'src', providerId)
  await fsp.mkdir(providerDir, { recursive: true })

  const baseSource = nameArg || stripKnownExtension(info.fileName || 'file')
  const safeBaseName = sanitizeFileName(baseSource)
  const jobDir = ensureUniqueDir(path.join(providerDir, safeBaseName))
  await fsp.mkdir(jobDir, { recursive: true })
  const jobRel = path.relative(projectRoot(), jobDir)

  const tooBigForWa = info.size != null && info.size > WA_MAX_BYTES

  // --- INFORMASI FILE DIKIRIM DULU, terpisah dari proses unduhnya ---
  await conn.sendMessage(
    m.chat,
    {
      text:
        `📦 *Informasi File*\n` +
        `🌐 Provider: ${label(providerId)}\n` +
        `📄 Nama asli: ${info.fileName || '-'}\n` +
        (nameArg ? `📝 Nama custom: ${nameArg}\n` : '') +
        (info.isList ? `🔢 Item ke-${info.itemIndex} dari ${info.listSize} di list\n` : '') +
        `📏 Ukuran: ${formatSize(info.size)}\n` +
        `📲 Kirim ke WA: ${waFlag ? (tooBigForWa ? `Tidak bisa — file melebihi batas WA bot ini (${formatSize(WA_MAX_BYTES)}); file hanya disimpan ke disk` : 'Ya') : 'Tidak (hanya disimpan ke disk)'}\n` +
        `🧹 Hapus file lokal setelah selesai (-c): ${cleanupFlag ? 'Ya' : 'Tidak'}\n` +
        (isExtractFlag ? `ℹ️ Flag -y dikenali, tapi ekstrak arsip belum tersedia di bot ini — diabaikan.\n` : '') +
        (cleanupFlag && !waFlag
          ? `⚠️ *Peringatan*: kirim WA nonaktif & cleanup aktif — file akan terhapus PERMANEN tanpa terkirim ke mana pun.\n`
          : '') +
        `\n⏳ Sedang mengunduh ke disk lokal...`
    },
    { quoted: m }
  )

  // --- PROSES UNDUH ---
  let result
  try {
    result = await engine.download(urlPart, info, { destDir: jobDir, baseName: safeBaseName, maxBytes: MAX_DOWNLOAD_BYTES })
    result = await normalizeXrarExtension(result)
  } catch (e) {
    void reportEngineError({ engineId: providerId, phase: 'download', error: e, url: urlPart })
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {})
    return conn.sendMessage(m.chat, { text: `❌ *Gagal mengunduh file*\n${e.message || e}` }, { quoted: m })
  }

  const stat = await fsp.stat(result.filePath).catch(() => null)
  const actualSize = stat?.size ?? result.size ?? 0

  // Engine warisan (Mega) tidak menegakkan maxBytes saat streaming — cek di sini.
  if (actualSize > MAX_DOWNLOAD_BYTES) {
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {})
    return conn.sendMessage(m.chat, { text: `❌ *File melewati batas unduhan* (${formatSize(MAX_DOWNLOAD_BYTES)}): ${formatSize(actualSize)}. File dihapus.` }, { quoted: m })
  }

  const sizeNote = info.size && actualSize && info.size !== actualSize
    ? `\n⚠️ Ukuran hasil unduh (${formatSize(actualSize)}) beda dari metadata (${formatSize(info.size)}).`
    : ''

  // --- KIRIM KE WHATSAPP (fitur baru dibanding legacy) ---
  let sentToWa = false
  if (waFlag && actualSize <= WA_MAX_BYTES) {
    try {
      await conn.sendFile(m.chat, result.filePath, result.fileName, `📄 ${result.fileName}\n🌐 ${label(providerId)}`, m)
      sentToWa = true
    } catch (e) {
      await conn.sendMessage(m.chat, { text: `⚠️ Gagal mengirim file ke WA:\n${e.message || e}\nFile tetap tersimpan di disk.` }, { quoted: m })
    }
  }

  if (!sentToWa) {
    await conn.sendMessage(
      m.chat,
      {
        text:
          `✅ *Download selesai!*\n` +
          `📄 ${result.fileName}\n` +
          `📏 ${formatSize(actualSize)}\n` +
          `📁 ${jobRel}` +
          sizeNote +
          (waFlag && actualSize > WA_MAX_BYTES
            ? `\n📲 Tidak dikirim ke WA: melebihi batas ${formatSize(WA_MAX_BYTES)}. Ambil lewat panel/file manager.`
            : '')
      },
      { quoted: m }
    )
  } else if (sizeNote) {
    await conn.sendMessage(m.chat, { text: sizeNote.trim() }, { quoted: m })
  }

  // --- CLEANUP (-c): hanya bila file tidak lagi dibutuhkan di disk ---
  // Bila pengiriman WA diminta tapi gagal, file DIPERTAHANKAN supaya bisa
  // diambil manual — cleanup tidak memaksa dalam kasus itu.
  if (cleanupFlag && (!waFlag || sentToWa)) {
    await fsp.rm(jobDir, { recursive: true, force: true })
    await conn.sendMessage(m.chat, {
      text: `🧹 *Cleanup selesai*\nFolder job sudah dihapus dari disk lokal.\n📁 ${jobRel}`
    })
  }
}

handler.help = ['unduh <url> | nama file | kirimWA(1/0) [-c]']
handler.tags = ['downloader']
handler.command = /^u(?:nduh)?$/i
handler.founder = true

export default handler
