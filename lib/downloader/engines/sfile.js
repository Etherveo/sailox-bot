// lib/downloader/engines/sfile.js
//
// Engine murni untuk SFile (sfile.mobi). Diporting dari legacy
// plugins/downloader-sfile.js yang memakai cheerio — di sini parsing
// halaman cukup dengan regex (pola yang sama seperti engine mediafire):
// nama dari atribut alt <img> di blok w3-row-padding, ukuran dari teks
// tombol #download ("Download File (12.3 MB)"), dan link unduhan dari
// href tombol itu ditambah parameter &k acak seperti legacy.

import path from 'node:path'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'

export const id = 'sfile'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
const INFO_TIMEOUT_MS = 30 * 1000

export function match(url = '') {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    return host === 'sfile.mobi' || host === 'www.sfile.mobi'
  } catch { return false }
}

/** "12.3 MB" / "850 KB" / "1,2 GB" -> byte (perkiraan, basis 1024). */
export function parseSizeText(text) {
  const m = String(text ?? '').replace(',', '.').match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i)
  if (!m) return null
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[m[2].toUpperCase()]
  return Math.round(parseFloat(m[1]) * mult)
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i')) || tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'))
  return m ? m[1] : null
}

export function scrapeSfile(html) {
  const anchor = html.match(/<a[^>]*id\s*=\s*"download"[^>]*>/i)?.[0] || html.match(/<a[^>]*id\s*=\s*'download'[^>]*>/i)?.[0]
  if (!anchor) return { success: false }
  let downloadUrl = attr(anchor, 'href')
  if (!downloadUrl) return { success: false }
  if (!/[?&]k=/.test(downloadUrl)) downloadUrl += `&k=${Math.floor(Math.random() * 6) + 10}`

  const anchorText = (html.match(/<a[^>]*id\s*=\s*"download"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '').replace(/<[^>]+>/g, ' ')
  const size = parseSizeText(anchorText.match(/\(([^)]+)\)/)?.[1] ?? anchorText)

  let fileName = null
  const blockStart = html.indexOf('w3-row-padding')
  if (blockStart >= 0) {
    const img = html.slice(blockStart, blockStart + 3000).match(/<img[^>]*>/i)?.[0]
    if (img) fileName = attr(img, 'alt')
  }
  if (!fileName) fileName = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.replace(/\s*[-|].*$/, '').trim() || null

  return { success: true, downloadUrl, fileName, size }
}

export async function getInfo(url, { fetchFn = fetch } = {}) {
  const res = await fetchFn(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`SFile merespons status ${res.status}.`)
  const scraped = scrapeSfile(await res.text())
  if (!scraped.success) throw new Error('Gagal mendapatkan link unduhan dari SFile (halaman berubah atau link sudah tidak valid).')
  return {
    fileName: scraped.fileName || decodeURIComponent(path.basename(new URL(scraped.downloadUrl).pathname) || '') || 'unknown.bin',
    size: scraped.size,
    downloadUrl: scraped.downloadUrl,
    pageUrl: url,
  }
}

export async function download(url, info, { destDir, baseName, maxBytes, fetchFn = fetch } = {}) {
  const response = await fetchFn(info.downloadUrl, { headers: { 'User-Agent': UA, Referer: info.pageUrl || url } })
  if (!response.ok) throw new Error(`Gagal mengunduh file (${response.status})`)
  const mimetype = response.headers.get('content-type') || 'application/octet-stream'
  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)
  const bytes = await streamToFile(response.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}
