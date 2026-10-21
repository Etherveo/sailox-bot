// lib/downloader/engines/mediafire.js
//
// Engine murni untuk MediaFire. Diporting dari legacy
// lib/downloader/engines/mediafire.js + lib/mediafire.js (scrapeMediaFire).
// Legacy memakai jsdom hanya untuk menemukan tombol #downloadButton —
// di sini cukup regex atas tag tombol itu (href biasa, atau
// data-scrambled-url yang isinya base64 link langsung).

import path from 'node:path'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'

export const id = 'mediafire'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
const INFO_TIMEOUT_MS = 30 * 1000

export function match(url = '') {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    return host === 'mediafire.com' || host.endsWith('.mediafire.com')
  } catch { return false }
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i')) || tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'))
  return m ? m[1] : null
}

/** Ambil link unduhan langsung dari halaman MediaFire. */
export async function scrapeMediaFire(url, { fetchFn = fetch } = {}) {
  const res = await fetchFn(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) })
  if (!res.ok) return { success: false, downloadUrl: null }
  const html = await res.text()
  const tag = html.match(/<a[^>]*id\s*=\s*"downloadButton"[^>]*>/i)?.[0]
    || html.match(/<a[^>]*id\s*=\s*'downloadButton'[^>]*>/i)?.[0]
  if (!tag) return { success: false, downloadUrl: null }

  const scrambled = attr(tag, 'data-scrambled-url')
  if (scrambled) {
    try { return { success: true, downloadUrl: Buffer.from(scrambled, 'base64').toString('utf-8') } } catch { /* lanjut ke href */ }
  }
  const href = attr(tag, 'href') || attr(tag, 'data-href')
  return href ? { success: true, downloadUrl: href } : { success: false, downloadUrl: null }
}

export async function getInfo(url, { fetchFn = fetch } = {}) {
  const result = await scrapeMediaFire(url, { fetchFn })
  if (!result?.success || !result?.downloadUrl) {
    throw new Error('Gagal mendapatkan link unduhan dari MediaFire (link mungkin sudah tidak valid).')
  }

  const downloadUrl = result.downloadUrl
  const fileName = result.fileName || decodeURIComponent(path.basename(new URL(downloadUrl).pathname) || '') || 'unknown.bin'

  let size = null
  let mimetype = null
  try {
    const head = await fetchFn(downloadUrl, { method: 'HEAD', signal: AbortSignal.timeout(INFO_TIMEOUT_MS) })
    size = parseInt(head.headers.get('content-length') || '0', 10) || null
    mimetype = head.headers.get('content-type') || null
  } catch {
    // Beberapa link MediaFire menolak HEAD, gak fatal — lanjut tanpa size pasti.
  }

  return { fileName, size, downloadUrl, mimetype }
}

export async function download(url, info, { destDir, baseName, maxBytes, fetchFn = fetch } = {}) {
  const response = await fetchFn(info.downloadUrl, { headers: { 'User-Agent': UA } })
  if (!response.ok) throw new Error(`Gagal mengunduh file (${response.status})`)

  const mimetype = response.headers.get('content-type') || info.mimetype || 'application/octet-stream'
  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)

  const bytes = await streamToFile(response.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}
