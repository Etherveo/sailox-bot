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
export const MAX_SOUND_SECONDS = 25 // durasi maks audio/stiker video .sa

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
    if (count > MAX_WM_CHARS) throw `${label} kepanjangan: ${count} karakter — maksimal ${MAX_WM_CHARS} karakter.`
    // Karakter kontrol tidak boleh masuk EXIF (bisa merusak parser
    // metadata); JSON.stringify memang meng-escape-nya, tapi tolak saja
    // di depan supaya input aneh tidak lolos ke mana pun.
    if (/[\u0000-\u001F\u007F]/.test(value)) throw `${label} mengandung karakter kontrol yang tidak diizinkan.`
  }
  return { packname, author }
}

// Batas video sesuai spesifikasi: durasi DI BAWAH 10 detik dan ukuran
// maksimal 5 MB. Nilai 0 = tidak diketahui -> lolos di tahap ini,
// pemeriksaan berikutnya (metadata unduhan / ffprobe) yang memutuskan.
export function assertVideoLimits({ seconds = 0, bytes = 0 } = {}) {
  if (seconds >= MAX_VIDEO_SECONDS) throw `Durasi video ${seconds} detik — harus di bawah ${MAX_VIDEO_SECONDS} detik.`
  if (bytes > MAX_VIDEO_BYTES) throw `Ukuran video ${(bytes / 1048576).toFixed(1)} MB — maksimal 5 MB untuk stiker video.`
}

// ── EXIF WebP ────────────────────────────────────────────────────────────
// Header TIFF kecil yang dipakai penulis stiker WhatsApp pada umumnya:
// satu entri tag 0x5741 berisi JSON metadata pack.
export function buildStickerExif({ packname, author, packId, emojis = [''] }) {
  const json = Buffer.from(JSON.stringify({
    'sticker-pack-id': packId,
    'sticker-pack-name': packname,
    'sticker-pack-publisher': author,
    emojis,
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

// ── WebP animasi ─────────────────────────────────────────────────────────
// Decoder WebP bawaan ffmpeg TIDAK bisa membaca WebP animasi: chunk
// ANIM/ANMF dilewati lalu gagal 'image data not found'. Padahal dokumen
// .webp dan stiker WA umumnya animasi — itu sebabnya `.s` gagal dengan
// pesan generik untuk dokumen .webp (WebP statis jalan normal). Jalur
// keluarnya: Pillow (Python, sudah ada di server) men-decode WebP animasi
// — termasuk alpha — lalu menulis GIF yang bisa dibaca ffmpeg. Durasi
// tiap frame dibaca langsung dari header chunk ANMF (3 byte LE di offset
// 12), karena info durasi PIL untuk WebP tidak bisa diandalkan.
export function isWebp(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'
}

export function isAnimatedWebp(buffer) {
  if (!isWebp(buffer)) return false
  try {
    const chunks = parseWebpChunks(buffer)
    const vp8x = chunks.find(c => c.tag === 'VP8X')
    if (vp8x && (vp8x.data[0] & 0x02)) return true
    return chunks.some(c => c.tag === 'ANIM')
  } catch { return false }
}

// Durasi tiap frame animasi (ms) dari chunk ANMF; [] bila bukan animasi.
export function webpFrameDurations(buffer) {
  if (!isWebp(buffer)) return []
  try {
    return parseWebpChunks(buffer)
      .filter(c => c.tag === 'ANMF' && c.data.length >= 15)
      .map(c => c.data.readUIntLE(12, 3))
  } catch { return [] }
}

// Windows tidak punya `python3` di PATH (yang ada `python`/`py`) — cari
// interpreter Python yang tersedia, urutan: python3 -> python -> py.
// Di Linux/VPS `python3` selalu ketemu duluan, jadi ini no-op di sana.
// Sengaja tanpa cache sendiri: pillowAvailable() sudah men-cache hasilnya.
export async function pythonCmd() {
  for (const cmd of ['python3', 'python', 'py']) {
    try { await execFileP(cmd, ['-c', 'pass'], { timeout: 5000 }); return cmd } catch { /* coba berikutnya */ }
  }
  return null
}

let pillowCache = null
export async function pillowAvailable() {
  if (pillowCache === null) {
    const py = await pythonCmd()
    if (!py) { pillowCache = false }
    else {
      try { await execFileP(py, ['-c', 'from PIL import Image'], { timeout: 10000 }); pillowCache = true } catch { pillowCache = false }
    }
  }
  return pillowCache
}

// Skrip Pillow: WebP animasi -> GIF (frame RGBA apa adanya, tanpa resize).
// Durasi per frame diterima sebagai argv JSON (dari webpFrameDurations);
// bila kosong, tiap frame dianggap 100 ms.
const WEBP_TO_GIF_PY = `
import sys, json
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
durations = json.loads(sys.argv[3])
im = Image.open(src)
frames = []
for i in range(im.n_frames):
    im.seek(i)
    frames.append(im.convert('RGBA'))
if not durations:
    durations = [100] * len(frames)
frames[0].save(dst, 'GIF', save_all=True, append_images=frames[1:], duration=durations, loop=0)
print(json.dumps({'frames': len(frames), 'durationMs': sum(durations)}))
`

// WebP animasi -> GIF (apa adanya, tanpa resize). Dipakai mediaToSticker
// (stiker animasi) dan .toimg (stiker -> gambar). Batas yang sama dengan
// stiker video: durasi di bawah 10 detik, GIF maksimal 5 MB.
export async function webpAnimatedToGif(buffer, { root } = {}) {
  if (!await pillowAvailable()) throw new Error('WebP animasi tidak bisa diproses — Python Pillow tidak tersedia di server.')
  const durations = webpFrameDurations(buffer)
  const durationMs = durations.reduce((a, b) => a + b, 0)
  if (durations.length && durationMs >= MAX_VIDEO_SECONDS * 1000) throw `Durasi WebP ${(durationMs / 1000).toFixed(1)} detik — harus di bawah ${MAX_VIDEO_SECONDS} detik.`
  const dir = path.join(root ?? process.cwd(), 'tmp')
  await fs.mkdir(dir, { recursive: true })
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const input = path.join(dir, `webp-in-${stamp}.webp`)
  const output = path.join(dir, `webp-out-${stamp}.gif`)
  try {
    await fs.writeFile(input, buffer)
    const py = await pythonCmd()
    if (!py) throw new Error('WebP animasi tidak bisa diproses — Python Pillow tidak tersedia di server.')
    const { stdout } = await execFileP(py, ['-c', WEBP_TO_GIF_PY, input, output, JSON.stringify(durations)], { timeout: 60000, maxBuffer: 1024 * 1024 })
    const { frames, durationMs: totalMs } = JSON.parse(String(stdout).trim())
    if (!durations.length && totalMs >= MAX_VIDEO_SECONDS * 1000) throw `Durasi WebP ${(totalMs / 1000).toFixed(1)} detik — harus di bawah ${MAX_VIDEO_SECONDS} detik.`
    const gif = await fs.readFile(output)
    if (gif.length > MAX_VIDEO_BYTES) throw `Ukuran WebP ${(gif.length / 1048576).toFixed(1)} MB — maksimal 5 MB untuk stiker animasi.`
    return { gif, frames, durationMs: totalMs }
  } finally {
    await fs.rm(input, { force: true }).catch(() => {})
    await fs.rm(output, { force: true }).catch(() => {})
  }
}

export async function mediaToSticker(buffer, { kind, root, packname, author, seconds = 0, packId, emojis } = {}) {
  if (!await ffmpegAvailable()) throw new Error('ffmpeg tidak tersedia di server — sticker maker sedang nonaktif.')
  // WebP animasi tidak bisa didekode ffmpeg: normalisasi dulu ke GIF via
  // Pillow, lalu jalankan jalur video (stiker animasi). WebP statis tetap
  // lewat jalur ffmpeg biasa.
  let inputBuffer = buffer
  let inputKind = kind
  let inputSeconds = seconds
  if (isAnimatedWebp(buffer)) {
    const { gif, durationMs } = await webpAnimatedToGif(buffer, { root })
    inputBuffer = gif
    inputKind = 'video'
    inputSeconds = durationMs / 1000
  }
  const dir = path.join(root, 'tmp')
  await fs.mkdir(dir, { recursive: true })
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const input = path.join(dir, `sticker-in-${stamp}`)
  const output = path.join(dir, `sticker-out-${stamp}.webp`)
  try {
    await fs.writeFile(input, inputBuffer)
    if (inputKind === 'video') {
      const duration = inputSeconds > 0 ? inputSeconds : await probeDurationSeconds(input).catch(() => null)
      if (duration !== null && duration >= MAX_VIDEO_SECONDS) throw `Durasi video ${duration.toFixed(1)} detik — harus di bawah ${MAX_VIDEO_SECONDS} detik.`
    }
    const vf = `${inputKind === 'video' ? 'fps=15,' : ''}scale=${STICKER_SIZE}:${STICKER_SIZE}:flags=lanczos:force_original_aspect_ratio=decrease,format=rgba,pad=${STICKER_SIZE}:${STICKER_SIZE}:(ow-iw)/2:(oh-ih)/2:color=#00000000,setsar=1`
    // '-fps_mode passthrough' = '-vsync 0' versi baru: jangan buang/duplikasi
    // frame. '-vsync' dihapus di ffmpeg 9 (laptop Veo: "Unrecognized option
    // 'vsync'") — '-fps_mode' ada sejak ffmpeg 7.1, jadi aman di 8.1 (VM)
    // maupun 9.1.
    const args = ['-y', '-i', input, '-vf', vf, '-vcodec', 'libwebp', '-lossless', '0', '-q:v', '75', '-preset', 'default', '-loop', '0', '-an', '-fps_mode', 'passthrough', ...(inputKind === 'image' ? ['-frames:v', '1'] : ['-t', String(MAX_VIDEO_SECONDS)]), '-f', 'webp', output]
    await execFileP('ffmpeg', args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    const webp = await fs.readFile(output)
    return addExifToWebp(webp, { packname, author, packId: packId ?? `sailox-${crypto.randomBytes(8).toString('hex')}`, emojis })
  } finally {
    await fs.rm(input, { force: true }).catch(() => {})
    await fs.rm(output, { force: true }).catch(() => {})
  }
}

const cleanupFiles = (...files) => Promise.all(files.map(f => fs.rm(f, { force: true }).catch(() => {})))

// ── Sound sticker (.sa) ──────────────────────────────────────────────────
// Dua primitif ini dulu tinggal di plugins/sticker/stickeraudio.js; pindah
// ke sini supaya dipakai DUA konsumen: plugin .sa di bot utama DAN layanan
// konversi sub-bot di proses utama (lib/subbot/convertService.js). Plugin
// tetap pemilik alur (sesi foto->audio, patch proto, pengiriman).

// Audio apa pun -> OGG Opus mono 48kHz (format VN WA), dipotong 25 dtk.
export async function toOggOpus(buffer, { root }) {
  const dir = path.join(root, 'tmp')
  await fs.mkdir(dir, { recursive: true })
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const input = path.join(dir, `sa-in-${stamp}`)
  const output = path.join(dir, `sa-out-${stamp}.ogg`)
  try {
    await fs.writeFile(input, buffer)
    const seconds = await probeDurationSeconds(input).catch(() => null)
    await execFileP('ffmpeg', ['-y', '-i', input, '-vn', '-map', '0:a:0', '-t', String(MAX_SOUND_SECONDS), '-af', 'aresample=48000:async=1:first_pts=0', '-c:a', 'libopus', '-b:a', '48k', '-vbr', 'on', '-compression_level', '10', '-ac', '1', '-ar', '48000', '-application', 'audio', '-f', 'ogg', output], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    const ogg = await fs.readFile(output)
    if (!ogg || ogg.length < 200) throw new Error('Jalur audio kosong atau terlalu pendek.')
    return { ogg, seconds: seconds ?? 0 }
  } finally {
    await cleanupFiles(input, output)
  }
}

// Video (maks 25 dtk) -> stiker WebP animasi 512x512. Tangga fps/kualitas
// ala Yue supaya hasilnya muat di bawah 880 KB; EXIF ditulis helper
// Sailox (addExifToWebp) supaya watermark pack/author konsisten dengan .s.
export async function makeVideoSticker(buffer, packname, author, { root, emojis = ['🔊'] }) {
  const dir = path.join(root, 'tmp')
  await fs.mkdir(dir, { recursive: true })
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const input = path.join(dir, `sa-vid-in-${stamp}.mp4`)
  const output = path.join(dir, `sa-vid-out-${stamp}.webp`)
  try {
    await fs.writeFile(input, buffer)
    let webp = null
    for (const [fps, qv] of [[10, 50], [8, 36], [6, 24], [5, 16], [4, 12], [3, 8]]) {
      // '-fps_mode passthrough' = '-vsync 0' versi baru (dihapus ffmpeg 9).
      await execFileP('ffmpeg', ['-y', '-i', input, '-t', String(MAX_SOUND_SECONDS), '-vf', `fps=${fps},scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=decrease,format=rgba,pad=${STICKER_SIZE}:${STICKER_SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1`, '-vcodec', 'libwebp', '-lossless', '0', '-compression_level', '6', '-q:v', String(qv), '-loop', '0', '-preset', 'picture', '-an', '-fps_mode', 'passthrough', output], { timeout: 90000, maxBuffer: 4 * 1024 * 1024 })
      webp = await fs.readFile(output)
      if (webp.length <= 880 * 1024) break
    }
    return addExifToWebp(webp, { packname, author, packId: `sailox-sa-${crypto.randomBytes(8).toString('hex')}`, emojis })
  } finally {
    await cleanupFiles(input, output)
  }
}
