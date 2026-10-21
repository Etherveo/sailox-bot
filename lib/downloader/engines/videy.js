// lib/downloader/engines/videy.js
//
// Engine murni untuk Videy (videy.co). Diporting dari legacy
// plugins/downloader-videy.js: video selalu tinggal di CDN dengan pola
// tetap https://cdn.videy.co/<id>.mp4 — engine tinggal mengekstrak id
// dari URL halaman (?id=... atau /v/<id>), mengambil metadata lewat HEAD,
// lalu streaming dari CDN.

import path from 'node:path'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'

export const id = 'videy'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
const INFO_TIMEOUT_MS = 30 * 1000

export function videoIdOf(url) {
  try {
    const u = new URL(String(url))
    if (!(u.hostname === 'videy.co' || u.hostname === 'www.videy.co')) return null
    return u.searchParams.get('id') || u.pathname.match(/\/v\/([A-Za-z0-9_-]+)/)?.[1] || null
  } catch { return null }
}

export function match(url = '') {
  return videoIdOf(url) !== null
}

export async function getInfo(url, { fetchFn = fetch } = {}) {
  const videoId = videoIdOf(url)
  if (!videoId) throw new Error('ID video Videy tidak ditemukan di URL.')
  const downloadUrl = `https://cdn.videy.co/${videoId}.mp4`
  let size = null, mimetype = 'video/mp4'
  try {
    const head = await fetchFn(downloadUrl, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) })
    if (head.ok) {
      size = parseInt(head.headers.get('content-length') || '0', 10) || null
      mimetype = head.headers.get('content-type') || mimetype
    }
  } catch { /* HEAD ditolak CDN — lanjut tanpa ukuran pasti */ }
  return { fileName: `${videoId}.mp4`, size, mimetype, downloadUrl }
}

export async function download(url, info, { destDir, baseName, maxBytes, fetchFn = fetch } = {}) {
  const response = await fetchFn(info.downloadUrl, { headers: { 'User-Agent': UA } })
  if (!response.ok) throw new Error(`Gagal mengunduh video (${response.status})`)
  const mimetype = response.headers.get('content-type') || info.mimetype || 'video/mp4'
  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)
  const bytes = await streamToFile(response.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}
