// Smeme: gambar + teks meme kapital bergaya Impact (putih, garis tepi
// hitam) di atas dan/atau bawah gambar, lalu dijadikan stiker.
// Penerus sticker-smeme.js legacy yang memakai paket `canvas` — di sini
// teks digambar oleh ffmpeg drawtext memakai font yang sama persis
// (src/font/impact.ttf, impor dari legacy), tanpa dependensi native baru,
// dan hasil gambarnya mengalir ke konverter stiker yang sama
// (lib/media/sticker.js) supaya watermark pack/author konsisten.
//
// Format (ditetapkan founder 2026-10-24, merevisi urutan legacy):
//   .smeme teks_atas|teks_bawah -<ukuran>
// - Segmen sebelum "|" = teks ATAS, sesudahnya = teks BAWAH.
//   Satu segmen tanpa "|" diperlakukan sebagai teks BAWAH (kebiasaan
//   meme satu baris dari era legacy).
// - Ukuran font opsional: sufiks " -N" di akhir (N = 10–120, bawaan 70 px,
//   relatif ke ukuran gambar asli). Sufiks di luar rentang dibiarkan
//   sebagai teks. Angka literal biasa TIDAK lagi ditafsirkan sebagai
//   ukuran — harus pakai tanda "-" supaya tidak termakan.
// - Teks selalu ditampilkan HURUF KAPITAL.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ffmpegAvailable } from './sticker.js'

const execFileP = promisify(execFile)

export const SMEME_FONT_FILE = 'impact.ttf'
export const SMEME_DEFAULT_SIZE = 70
export const SMEME_MIN_SIZE = 10
export const SMEME_MAX_SIZE = 120

export function parseSmemeText(text) {
  let content = String(text ?? '').replace(/\s*\n\s*/g, ' ').trim()
  if (!content) return null
  let fontSize = SMEME_DEFAULT_SIZE
  const sizeMatch = content.match(/\s+-(\d{1,3})\s*$/)
  if (sizeMatch) {
    const parsed = Number.parseInt(sizeMatch[1], 10)
    if (parsed >= SMEME_MIN_SIZE && parsed <= SMEME_MAX_SIZE) {
      fontSize = parsed
      content = content.slice(0, sizeMatch.index).trim()
    }
  }
  const idx = content.indexOf('|')
  const topRaw = idx < 0 ? '' : content.slice(0, idx)
  const bottomRaw = idx < 0 ? content : content.slice(idx + 1)
  // "%{" adalah pembuka ekspresi drawtext — netralkan dari teks pengguna.
  const clean = s => String(s ?? '').replace(/%\{/g, '% {').trim().toUpperCase()
  const bottom = clean(bottomRaw)
  const top = clean(topRaw)
  if (!bottom && !top) return null
  return { top, bottom, fontSize }
}

export function smemeFontPath(root) {
  return path.join(root, 'src', 'font', SMEME_FONT_FILE)
}

// Gambar buffer -> PNG buffer berteks. Posisi sama seperti legacy:
// atas di y=40, bawah di (tinggi - tinggi teks - 40), selalu tengah,
// garis tepi fontSize/6.
export async function drawSmemeText(buffer, { root, top = '', bottom = '', fontSize = SMEME_DEFAULT_SIZE } = {}) {
  if (!await ffmpegAvailable()) throw new Error('ffmpeg tidak tersedia di server — smeme sedang nonaktif.')
  const font = smemeFontPath(root)
  if (!await fs.stat(font).catch(() => null)) throw new Error(`Font ${SMEME_FONT_FILE} tidak ditemukan di src/font — aset font belum diimpor.`)
  const dir = path.join(root, 'tmp')
  await fs.mkdir(dir, { recursive: true })
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const input = path.join(dir, `smeme-in-${stamp}`)
  const output = path.join(dir, `smeme-out-${stamp}.png`)
  const textFiles = []
  try {
    await fs.writeFile(input, buffer)
    const border = Math.max(1, Math.round(fontSize / 6))
    const filters = []
    for (const [text, isTop] of [[top, true], [bottom, false]]) {
      if (!text) continue
      const tf = path.join(dir, `smeme-text-${stamp}-${isTop ? 'top' : 'bottom'}.txt`)
      await fs.writeFile(tf, text)
      textFiles.push(tf)
      filters.push(`drawtext=fontfile=${font}:textfile=${tf}:fontsize=${fontSize}:fontcolor=white:bordercolor=black:borderw=${border}:x=(w-text_w)/2:y=${isTop ? '40' : 'h-text_h-40'}`)
    }
    if (!filters.length) throw new Error('Teks smeme kosong.')
    await execFileP('ffmpeg', ['-y', '-i', input, '-vf', filters.join(','), '-frames:v', '1', '-f', 'image2', output], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    return await fs.readFile(output)
  } finally {
    await fs.rm(input, { force: true }).catch(() => {})
    await fs.rm(output, { force: true }).catch(() => {})
    for (const tf of textFiles) await fs.rm(tf, { force: true }).catch(() => {})
  }
}
