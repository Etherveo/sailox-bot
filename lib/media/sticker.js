// Sticker maker: gambar/video pendek -> stiker WebP 512x512 + metadata
// watermark (nama pack & author) di chunk EXIF, format yang dibaca
// WhatsApp. Semua lokal — ffmpeg (libwebp) untuk konversi dan penulisan
// EXIF manual per kontainer WebP; TANPA layanan konversi eksternal dan
// tanpa dependensi baru (penerus lib/exif.js + lib/sticker.js legacy,
// yang dulu memakai fluent-ffmpeg/node-webpmux/wa-sticker-formatter).
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export const STICKER_SIZE = 512
export const MAX_WM_CHARS = 39
export const MAX_VIDEO_SECONDS = 10
export const MAX_VIDEO_BYTES = 5 * 1024 * 1024

// ".s <pack> | <author>" — masing-masing opsional (kosong = bawaan),
// masing-masing maksimal MAX_WM_CHARS karakter (poin kode Unicode).
// Pemisah hanya "|" pertama; author boleh mengandung "|" lagi.
export function parseStickerArgs(text, defaults = {}) {
  const raw = String(text ?? '')
  const idx = raw.indexOf('|')
  const packname = (idx < 0 ? raw : raw.slice(0, idx)).trim() || defaults.packname || ''
  const author = (idx < 0 ? '' : raw.slice(idx + 1)).trim() || defaults.author || ''
  for (const [label, value] of [['Pack', packname], ['Author', author]]) {
    const count = [...value].length
    if (count > MAX_WM_CHARS) throw new Error(`${label} kepanjangan: ${count} karakter — maksimal ${MAX_WM_CHARS} karakter.`)
  }
  return { packname, author }
}

// Batas video sesuai spesifikasi: durasi DI BAWAH 10 detik dan ukuran
// maksimal 5 MB. Nilai 0 = tidak diketahui -> lolos di tahap ini,
// pemeriksaan berikutnya (metadata unduhan / ffprobe) yang memutuskan.
export function assertVideoLimits({ seconds = 0, bytes = 0 } = {}) {
  if (seconds >= MAX_VIDEO_SECONDS) throw new Error(`Durasi video ${seconds} detik — harus di bawah ${MAX_VIDEO_SECONDS} detik.`)
  if (bytes > MAX_VIDEO_BYTES) throw new Error(`Ukuran video ${(bytes / 1048576).toFixed(1)} MB — maksimal 5 MB untuk stiker video.`)
}

// ── EXIF WebP ────────────────────────────────────────────────────────────
// Header TIFF kecil yang dipakai penulis stiker WhatsApp pada umumnya:
// satu entri tag 0x5741 berisi JSON metadata pack.
export function buildStickerExif({ packname, author, packId }) {
  const json = Buffer.from(JSON.stringify({
    'sticker-pack-id': packId,
    'sticker-pack-name': packname,
    'sticker-pack-publisher': author,
    emojis: [''],
  }), 'utf8')
  const header = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00])
  const count = Buffer.alloc(4); count.writeUInt32LE(json.length)
  return Buffer.concat([header, count, Buffer.from([0x16, 0x00, 0x00, 0x00]), json])
}

export function parseWebpChunks(webp) {
  if (!Buffer.isBuffer(webp) || webp.length < 12 || webp.toString('ascii', 0, 4) !== 'RIFF' || webp.toString('ascii', 8, 12) !== 'WEBP') throw new Error('Bukan file WebP yang valid.')
  const chunks = []
  for (let off = 12; off + 8 <= webp.length;) {
    const tag = webp.toString('ascii', off, off + 4)
    const size = webp.readUInt32LE(off + 4)
    chunks.push({ tag, data: webp.subarray(off + 8, off + 8 + size) })
    off += 8 + size + (size % 2)
  }
  return chunks
}

function chunkBuffer(tag, data) {
  const head = Buffer.alloc(8)
  head.write(tag, 0, 'ascii'); head.writeUInt32LE(data.length, 4)
  return data.length % 2 ? Buffer.concat([head, data, Buffer.from([0])]) : Buffer.concat([head, data])
}

// Sisipkan/ganti chunk EXIF. WebP sederhana (VP8/VP8L tanpa VP8X) diberi
// chunk VP8X baru dengan bendera EXIF menyala; kanvas dianggap
// width x height (hasil konverter selalu STICKER_SIZE persegi).
export function addExifToWebp(webp, meta, { width = STICKER_SIZE, height = STICKER_SIZE } = {}) {
  const chunks = parseWebpChunks(webp).filter(c => c.tag !== 'EXIF')
  const existing = chunks.find(c => c.tag === 'VP8X')
  const rest = chunks.filter(c => c.tag !== 'VP8X')
  let vp8x
  if (existing) { vp8x = Buffer.from(existing.data); vp8x[0] |= 0x08 }
  else {
    vp8x = Buffer.alloc(10)
    vp8x[0] = 0x08
    vp8x.writeUIntLE(Math.max(0, width - 1), 4, 3)
    vp8x.writeUIntLE(Math.max(0, height - 1), 7, 3)
  }
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), chunkBuffer('VP8X', vp8x), ...rest.map(c => chunkBuffer(c.tag, c.data)), chunkBuffer('EXIF', buildStickerExif(meta))])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'ascii'); riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

// Baca kembali metadata pack dari chunk EXIF (untuk tes & verifikasi).
export function extractStickerMeta(webp) {
  const exif = parseWebpChunks(webp).find(c => c.tag === 'EXIF')
  if (!exif) return null
  try { return JSON.parse(exif.data.subarray(22).toString('utf8')) } catch { return null }
}

// ── Konversi ffmpeg ──────────────────────────────────────────────────────
let ffmpegCache = null
export async function ffmpegAvailable() {
  if (ffmpegCache === null) {
    try { await execFileP('ffmpeg', ['-version'], { timeout: 10000 }); ffmpegCache = true } catch { ffmpegCache = false }
  }
  return ffmpegCache
}

export async function probeDurationSeconds(file) {
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 15000 })
  const seconds = parseFloat(String(stdout).trim())
  return Number.isFinite(seconds) ? seconds : null
}

export async function mediaToSticker(buffer, { kind, root, packname, author, seconds = 0, packId } = {}) {
  if (!await ffmpegAvailable()) throw new Error('ffmpeg tidak tersedia di server — sticker maker sedang nonaktif.')
  const dir = path.join(root, 'tmp')
  await fs.mkdir(dir, { recursive: true })
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const input = path.join(dir, `sticker-in-${stamp}`)
  const output = path.join(dir, `sticker-out-${stamp}.webp`)
  try {
    await fs.writeFile(input, buffer)
    if (kind === 'video') {
      const duration = seconds > 0 ? seconds : await probeDurationSeconds(input).catch(() => null)
      if (duration !== null && duration >= MAX_VIDEO_SECONDS) throw new Error(`Durasi video ${duration.toFixed(1)} detik — harus di bawah ${MAX_VIDEO_SECONDS} detik.`)
    }
    const vf = `${kind === 'video' ? 'fps=15,' : ''}scale=${STICKER_SIZE}:${STICKER_SIZE}:flags=lanczos:force_original_aspect_ratio=decrease,format=rgba,pad=${STICKER_SIZE}:${STICKER_SIZE}:(ow-iw)/2:(oh-ih)/2:color=#00000000,setsar=1`
    const args = ['-y', '-i', input, '-vf', vf, '-vcodec', 'libwebp', '-lossless', '0', '-q:v', '75', '-preset', 'default', '-loop', '0', '-an', '-vsync', '0', ...(kind === 'image' ? ['-frames:v', '1'] : ['-t', String(MAX_VIDEO_SECONDS)]), '-f', 'webp', output]
    await execFileP('ffmpeg', args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    const webp = await fs.readFile(output)
    return addExifToWebp(webp, { packname, author, packId: packId ?? `sailox-${crypto.randomBytes(8).toString('hex')}` })
  } finally {
    await fs.rm(input, { force: true }).catch(() => {})
    await fs.rm(output, { force: true }).catch(() => {})
  }
}
