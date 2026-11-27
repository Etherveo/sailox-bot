// Validasi media PURE-JS (tanpa child process) untuk channel konversi
// stiker sub-bot.
//
// Dipakai dua sisi dengan peran berbeda: worker (lapisan 1, sebelum
// media dikirim ke bot utama) dan bot utama (lapisan 2 — sniff ulang
// byte salinan sebelum ffprobe + re-encode; jangan percaya apa pun yang
// diklaim worker). Sniff memakai `file-type` (dependensi yang sudah ada,
// dipakai lib/simple.js juga); dimensi dibaca langsung dari header
// (PNG IHDR, GIF LSD, JPEG SOF, WebP VP8X/VP8/VP8L) tanpa decode.
//
// Semua penolakan dilempar sebagai STRING (pesan ke pengirim, konvensi
// pipeline) — bukan Error.
import { fileTypeFromBuffer } from 'file-type'

export const MAX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_INPUT_VIDEO_BYTES = 5 * 1024 * 1024 // == MAX_VIDEO_BYTES stiker
export const MAX_INPUT_AUDIO_BYTES = 10 * 1024 * 1024
export const MAX_IMAGE_DIMENSION = 8000
export const MAX_IMAGE_PIXELS = 64 * 1024 * 1024
export const MAX_OUTPUT_STICKER_BYTES = 2 * 1024 * 1024
export const MAX_OUTPUT_AUDIO_BYTES = 1 * 1024 * 1024

const IMAGE_EXTS = new Set(['png', 'jpg', 'webp', 'gif'])
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'mkv', 'ogv'])
const AUDIO_EXTS = new Set(['mp3', 'ogg', 'opus', 'm4a', 'wav', 'aac', 'flac', 'spx'])

// Jenis konversi yang dilayani channel. maxSeconds = batas durasi dari
// metadata pesan (0 = tidak diketahui, lolos — ffprobe yang memutuskan);
// op '>=' berarti durasi SAMA DENGAN batas sudah ditolak ('< batas'),
// '>' berarti tepat di batas masih lolos.
export const CONVERT_JOBS = {
  'sticker-image': { kinds: ['image'], maxBytes: MAX_INPUT_IMAGE_BYTES, maxSeconds: 0 },
  'sticker-video': { kinds: ['video'], maxBytes: MAX_INPUT_VIDEO_BYTES, maxSeconds: 10, secondsOp: '>=' },
  'sa-video-sticker': { kinds: ['video'], maxBytes: MAX_INPUT_VIDEO_BYTES, maxSeconds: 25, secondsOp: '>' },
  'sa-audio': { kinds: ['audio', 'video'], maxBytes: MAX_INPUT_AUDIO_BYTES, maxSeconds: 300, secondsOp: '>' },
}

// Sniff magic bytes -> { ext, mime, kind } atau null bila tak dikenal /
// di luar whitelist. file-type membaca signature, bukan ekstensi nama.
export async function sniffMedia(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null
  const detected = await fileTypeFromBuffer(buffer).catch(() => null)
  if (!detected) return null
  if (IMAGE_EXTS.has(detected.ext)) return { ext: detected.ext, mime: detected.mime, kind: 'image' }
  if (VIDEO_EXTS.has(detected.ext)) return { ext: detected.ext, mime: detected.mime, kind: 'video' }
  if (AUDIO_EXTS.has(detected.ext)) return { ext: detected.ext, mime: detected.mime, kind: 'audio' }
  return null
}

function pngDimensions(buf) {
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function gifDimensions(buf) {
  if (buf.length < 10) return null
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

function jpegDimensions(buf) {
  let off = 2 // lewati SOI (FFD8)
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xFF) return null
    const marker = buf[off + 1]
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { off += 2; continue }
    const len = buf.readUInt16BE(off + 2)
    if (len < 2 || off + 2 + len > buf.length) return null
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) }
    }
    off += 2 + len
  }
  return null
}

function webpDimensions(buf) {
  if (buf.length < 20) return null
  const chunk = buf.toString('ascii', 12, 16)
  if (chunk === 'VP8X' && buf.length >= 30) return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 }
  if (chunk === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
    return {
      width: (buf[21] | ((buf[22] & 0x3f) << 8)) + 1,
      height: (((buf[22] >> 6) | (buf[23] << 2) | ((buf[24] & 0x0f) << 10)) + 1),
    }
  }
  return null
}

// Dimensi gambar dari header (null bila tidak bisa dibaca).
export function parseImageDimensions(buffer, ext) {
  try {
    if (ext === 'png') return pngDimensions(buffer)
    if (ext === 'gif') return gifDimensions(buffer)
    if (ext === 'jpg') return jpegDimensions(buffer)
    if (ext === 'webp') return webpDimensions(buffer)
  } catch { return null }
  return null
}

const kindName = kind => kind === 'image' ? 'gambar' : kind === 'video' ? 'video' : 'audio'

// Validasi lapisan 1 (dan diulang lapisan 2 terhadap byte salinan):
// ukuran, format (magic bytes), kecocokan kind yang dideklarasikan,
// dimensi gambar, durasi dari metadata. Mengembalikan hasil sniff.
export async function validateConvertInput({ buffer, job, kind, seconds = 0 } = {}) {
  const spec = CONVERT_JOBS[job]
  if (!spec) throw 'Jenis konversi tidak dikenal.'
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw 'Media kosong — kirim ulang medianya.'
  if (buffer.length > spec.maxBytes) throw `Ukuran media ${(buffer.length / 1048576).toFixed(1)} MB — maksimal ${spec.maxBytes / 1048576} MB untuk konversi ini.`
  const sniffed = await sniffMedia(buffer)
  if (!sniffed) throw 'Format media tidak dikenali — kirim gambar (PNG/JPG/WebP/GIF), video (MP4/WebM/MOV), atau audio (MP3/OGG/M4A).'
  if (!spec.kinds.includes(sniffed.kind)) throw `Media ini ${kindName(sniffed.kind)}, bukan ${spec.kinds.map(kindName).join(' atau ')} — tidak bisa dikonversi ke jenis ini.`
  if (kind && kind !== sniffed.kind) throw 'Jenis media tidak cocok dengan yang dideklarasikan.'
  if (sniffed.kind === 'image') {
    const dims = parseImageDimensions(buffer, sniffed.ext)
    if (!dims) throw 'Dimensi gambar tidak bisa dibaca — file gambarnya rusak.'
    if (dims.width <= 0 || dims.height <= 0 || dims.width > MAX_IMAGE_DIMENSION || dims.height > MAX_IMAGE_DIMENSION) throw `Dimensi gambar ${dims.width}x${dims.height} di luar batas (maks ${MAX_IMAGE_DIMENSION}px).`
    if (dims.width * dims.height > MAX_IMAGE_PIXELS) throw 'Resolusi gambar terlalu besar.'
  }
  if (spec.maxSeconds && seconds > 0) {
    const over = spec.secondsOp === '>=' ? seconds >= spec.maxSeconds : seconds > spec.maxSeconds
    if (over) throw `Durasi media ${seconds} detik — maksimal ${spec.secondsOp === '>=' ? 'di bawah ' : ''}${spec.maxSeconds} detik.`
  }
  return sniffed
}

// Verifikasi hasil konversi (sisi worker, sebelum dikirim sebagai stiker).
export function verifyStickerOutput(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') throw 'Hasil konversi bukan stiker WebP yang valid.'
  if (buffer.length > MAX_OUTPUT_STICKER_BYTES) throw 'Hasil stiker terlalu besar.'
  return true
}

export function verifyAudioOutput(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.toString('ascii', 0, 4) !== 'OggS') throw 'Hasil konversi bukan audio OGG yang valid.'
  if (buffer.length > MAX_OUTPUT_AUDIO_BYTES) throw 'Hasil audio terlalu besar.'
  return true
}
