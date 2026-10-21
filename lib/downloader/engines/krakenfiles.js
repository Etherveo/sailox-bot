// lib/downloader/engines/krakenfiles.js
//
// Engine murni untuk KrakenFiles (krakenfiles.com). Diporting dari legacy
// plugins/downloader-kraken.js — legacy mengambil halaman lewat proxy CORS
// pihak ketiga karena berjalan di browser-like context; dari server bot
// halaman diambil langsung. Link unduhan adalah <source src> di dalam
// <video> pada halaman view (cakupan yang sama seperti legacy: berkas
// video). Judul dari <title> halaman.

import path from 'node:path'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'

export const id = 'krakenfiles'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
const INFO_TIMEOUT_MS = 30 * 1000

export function match(url = '') {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    return host === 'krakenfiles.com' || host === 'www.krakenfiles.com'
  } catch { return false }
}

export function scrapeKraken(html) {
  const videoTag = html.match(/<video[\s\S]*?<\/video>/i)?.[0] ?? ''
  const source = videoTag.match(/<source[^>]*src\s*=\s*"([^"]+)"/i)?.[1] || videoTag.match(/<source[^>]*src\s*=\s*'([^']+)'/i)?.[1]
    || html.match(/<source[^>]*src\s*=\s*"([^"]+)"/i)?.[1]
  if (!source) return { success: false }
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.replace(/\s*-\s*Krakenfiles\.com.*$/i, '').trim() || null
  return { success: true, downloadUrl: source, title }
}

export async function getInfo(url, { fetchFn = fetch } = {}) {
  const res = await fetchFn(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`KrakenFiles merespons status ${res.status}.`)
  const scraped = scrapeKraken(await res.text())
  if (!scraped.success) throw new Error('Tidak ditemukan link unduhan langsung di halaman KrakenFiles (mungkin berkas non-video atau halaman berubah).')
  const ext = path.extname(new URL(scraped.downloadUrl).pathname) || '.mp4'
  const fileName = scraped.title ? (path.extname(scraped.title) ? scraped.title : scraped.title + ext) : decodeURIComponent(path.basename(new URL(scraped.downloadUrl).pathname)) || 'krakenfile.mp4'
  let size = null, mimetype = null
  try {
    const head = await fetchFn(scraped.downloadUrl, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) })
    if (head.ok) {
      size = parseInt(head.headers.get('content-length') || '0', 10) || null
      mimetype = head.headers.get('content-type') || null
    }
  } catch { /* HEAD gagal — lanjut tanpa ukuran pasti */ }
  return { fileName, size, mimetype, downloadUrl: scraped.downloadUrl }
}

export async function download(url, info, { destDir, baseName, maxBytes, fetchFn = fetch } = {}) {
  const response = await fetchFn(info.downloadUrl, { headers: { 'User-Agent': UA, Referer: url } })
  if (!response.ok) throw new Error(`Gagal mengunduh file (${response.status})`)
  const mimetype = response.headers.get('content-type') || info.mimetype || 'application/octet-stream'
  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)
  const bytes = await streamToFile(response.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}
