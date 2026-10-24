// Brat: stiker teks putih bergaya "brat" — teks gelap rata-tepi
// (justify) di atas latar putih, dirender kecil lalu diperbesar supaya
// blur khasnya dapat. Penerus sticker-brat.js legacy yang memakai paket
// `canvas`. Paket itu tidak ada di engine ini, jadi di sini:
// - Lebar teks diukur dari metrik TTF asli (parser tabel cmap/hmtx
//   Roboto-Regular.ttf dari src/font — tanpa dependensi native).
// - Gambar digambar ffmpeg drawtext per kata (untuk justify), dirender
//   di kanvas kecil 120px lalu di-upscale ke 480px (resep blur legacy).
// Algoritma layout meniru legacy persis: font menyusut dari 120 sampai
// pas (maks 4 baris, tinggi total muat), baris selain terakhir di-justify.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ffmpegAvailable } from './sticker.js'

const execFileP = promisify(execFile)

export const BRAT_FONT_FILE = 'Roboto-Regular.ttf'
export const BRAT_CANVAS = 480
export const BRAT_SMALL = 120
export const BRAT_MARGIN = 10
export const BRAT_MAX_FONT = 120
export const BRAT_MIN_FONT = 50
export const BRAT_MAX_LINES = 4
export const BRAT_MAX_CHARS = 150

// ── Metrik TTF minimal (cmap format 12/4 + hmtx) ────────────────────────
const fontCache = new Map()
export async function loadFontMetrics(fontPath) {
  if (fontCache.has(fontPath)) return fontCache.get(fontPath)
  const buf = await fs.readFile(fontPath)
  const u16 = off => buf.readUInt16BE(off)
  const u32 = off => buf.readUInt32BE(off)
  const tables = {}
  const numTables = u16(4)
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    tables[buf.toString('ascii', rec, rec + 4)] = { offset: u32(rec + 8), length: u32(rec + 12) }
  }
  const unitsPerEm = u16(tables.head.offset + 18)
  const numGlyphs = u16(tables.maxp.offset + 4)
  const numH = u16(tables.hhea.offset + 34)
  const advances = []
  for (let g = 0; g < numH; g++) advances.push(u16(tables.hmtx.offset + g * 4))
  const advanceOf = gid => advances[Math.min(gid, numH - 1)] ?? advances[advances.length - 1] ?? 0

  // Pilih subtable cmap: utamakan format 12, cadangan format 4.
  const cmapOff = tables.cmap.offset
  const subs = []
  const nSub = u16(cmapOff + 2)
  for (let i = 0; i < nSub; i++) {
    const rec = cmapOff + 4 + i * 8
    const off = cmapOff + u32(rec + 4)
    subs.push({ format: u16(off), off })
  }
  let glyphId
  const f12 = subs.find(s => s.format === 12)
  const f4 = subs.find(s => s.format === 4)
  if (f12) {
    const groups = []
    const nGroups = u32(f12.off + 12)
    for (let i = 0; i < nGroups; i++) {
      const g = f12.off + 16 + i * 12
      groups.push({ from: u32(g), to: u32(g + 4), glyph: u32(g + 8) })
    }
    glyphId = cp => {
      let lo = 0, hi = groups.length - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, g = groups[mid]
        if (cp < g.from) hi = mid - 1
        else if (cp > g.to) lo = mid + 1
        else return g.glyph + (cp - g.from)
      }
      return 0
    }
  } else if (f4) {
    const off = f4.off
    const segCount = u16(off + 6) / 2
    const endOff = off + 14
    const startOff = endOff + 2 * segCount + 2
    const deltaOff = startOff + 2 * segCount
    const rangeOff = deltaOff + 2 * segCount
    glyphId = cp => {
      if (cp > 0xFFFF) return 0
      for (let s = 0; s < segCount; s++) {
        const end = u16(endOff + s * 2)
        if (cp > end) continue
        const start = u16(startOff + s * 2)
        if (cp < start) return 0
        const delta = buf.readInt16BE(deltaOff + s * 2)
        const range = u16(rangeOff + s * 2)
        if (range === 0) return (cp + delta) & 0xFFFF
        const giOff = rangeOff + s * 2 + range + (cp - start) * 2
        const gid = u16(giOff)
        return gid === 0 ? 0 : (gid + delta) & 0xFFFF
      }
      return 0
    }
  } else throw new Error('Font tidak punya cmap format 12/4 yang didukung.')

  const metrics = {
    unitsPerEm,
    numGlyphs,
    measure(text, fontSize) {
      let units = 0
      for (const ch of String(text)) units += advanceOf(glyphId(ch.codePointAt(0)))
      return units * fontSize / unitsPerEm
    },
  }
  fontCache.set(fontPath, metrics)
  return metrics
}

// ── Layout (persis legacy) ──────────────────────────────────────────────
export function layoutBratText(text, measure) {
  const usable = BRAT_CANVAS - BRAT_MARGIN * 2
  const words = String(text).trim().split(/\s+/).filter(Boolean)
  let fontSize = BRAT_MAX_FONT
  let lines = []
  let lineHeight = 0
  while (fontSize >= BRAT_MIN_FONT) {
    lines = []
    let current = ''
    for (const word of words) {
      const trial = current + word + ' '
      if (measure(trial, fontSize) > usable && current) { lines.push(current.trim()); current = word + ' ' }
      else current = trial
    }
    if (current) lines.push(current.trim())
    lineHeight = fontSize + 8
    const anyWordTooLong = words.some(w => measure(w, fontSize) > usable)
    if (!anyWordTooLong && lines.length * lineHeight + BRAT_MARGIN * 2 <= BRAT_CANVAS && lines.length <= BRAT_MAX_LINES) break
    fontSize--
  }
  return { fontSize, lines, lineHeight }
}

// ── Render ──────────────────────────────────────────────────────────────
export function bratFontPath(root) {
  return path.join(root, 'src', 'font', BRAT_FONT_FILE)
}

export async function renderBratPng(text, { root } = {}) {
  if (!await ffmpegAvailable()) throw new Error('ffmpeg tidak tersedia di server — brat sedang nonaktif.')
  const font = bratFontPath(root)
  if (!await fs.stat(font).catch(() => null)) throw new Error(`Font ${BRAT_FONT_FILE} tidak ditemukan di src/font — aset font belum diimpor.`)
  const metrics = await loadFontMetrics(font)
  const { fontSize, lines, lineHeight } = layoutBratText(text, metrics.measure)
  const scale = BRAT_CANVAS / BRAT_SMALL
  const smallFont = Math.floor(fontSize / scale)
  const smallLineHeight = lineHeight / scale
  const marginS = BRAT_MARGIN / scale
  const usableS = BRAT_SMALL - marginS * 2
  const spaceW = metrics.measure(' ', smallFont)

  const dir = path.join(root, 'tmp')
  await fs.mkdir(dir, { recursive: true })
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const output = path.join(dir, `brat-out-${stamp}.png`)
  const textFiles = []
  try {
    const filters = []
    let y = marginS
    lines.forEach((line, li) => {
      const words = line.split(' ')
      const isLast = li === lines.length - 1
      const placements = []
      if (words.length === 1 || isLast) placements.push({ word: line, x: marginS })
      else {
        const extra = (usableS - metrics.measure(line, smallFont)) / (words.length - 1)
        let x = marginS
        for (const word of words) {
          placements.push({ word, x })
          x += metrics.measure(word, smallFont) + spaceW + extra
        }
      }
      for (const p of placements) {
        const tf = path.join(dir, `brat-text-${stamp}-${textFiles.length}.txt`)
        textFiles.push(tf)
        filters.push({ tf, text: p.word, x: p.x, y })
      }
      y += smallLineHeight
    })
    await Promise.all(filters.map(f => fs.writeFile(f.tf, f.text)))
    const chain = filters.map(f => `drawtext=fontfile=${font}:textfile=${f.tf}:fontsize=${smallFont}:fontcolor=0x111111:x=${f.x.toFixed(2)}:y=${f.y.toFixed(2)}`).join(',')
    // Upscale harus LEMBUT: legacy memakai smoothing drawImage canvas
    // (≈ bilinear). Lanczos justru menajamkan tepi teks — itu sebabnya
    // versi awal terasa kurang blur. Bilinear + gblur tipis = brat.
    const vf = `${chain},scale=${BRAT_CANVAS}:${BRAT_CANVAS}:flags=bilinear,gblur=sigma=0.5,format=rgb24`
    await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=white:s=${BRAT_SMALL}x${BRAT_SMALL}`, '-vf', vf, '-frames:v', '1', output], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    return await fs.readFile(output)
  } finally {
    await fs.rm(output, { force: true }).catch(() => {})
    for (const tf of textFiles) await fs.rm(tf, { force: true }).catch(() => {})
  }
}
