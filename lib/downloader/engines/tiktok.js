// lib/downloader/engines/tiktok.js
//
// Engine murni untuk TikTok. Mekanismenya diganti total pada 2026-10-21
// mengikuti legacy plugins/downloader-download.js (versi yang menurut
// pemilik benar-benar bekerja): resolver bersama instatiktok.com — lihat
// lib/downloader/instatiktok.js. Pemilihan tautan setia legacy: tautan
// yang mengandung `hdplay` didahulukan, else tautan pertama. Resolver lama
// (tikwm/savetik) dibuang karena error di lapangan.

import path from 'node:path'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'
import { resolveInstaTiktok } from '../instatiktok.js'

export const id = 'tiktok'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
const INFO_TIMEOUT_MS = 30 * 1000

export function match(url = '') {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    return host === 'tiktok.com' || host.endsWith('.tiktok.com')
  } catch { return false }
}

export function pickTiktokLink(links) {
  if (!links?.length) return null
  return links.find(l => /hdplay/.test(l)) || links[0]
}

export async function getInfo(url, { fetchFn = fetch } = {}) {
  const links = await resolveInstaTiktok('tiktok', url, { fetchFn })
  const downloadUrl = pickTiktokLink(links)
  const videoId = String(url).match(/\/(?:video|photo)\/(\d+)/)?.[1] ?? 'video'
  let size = null, mimetype = 'video/mp4'
  try {
    const head = await fetchFn(downloadUrl, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) })
    if (head.ok) {
      size = parseInt(head.headers.get('content-length') || '0', 10) || null
      mimetype = head.headers.get('content-type') || mimetype
    }
  } catch { /* HEAD ditolak — lanjut tanpa ukuran pasti */ }
  const isImage = /^image\//.test(mimetype)
  return { fileName: `tiktok-${videoId}.${isImage ? 'jpg' : 'mp4'}`, size, mimetype, downloadUrl }
}

export async function download(url, info, { destDir, baseName, maxBytes, fetchFn = fetch } = {}) {
  if (!info?.downloadUrl) throw new Error('Info TikTok tidak membawa link unduhan.')
  const response = await fetchFn(info.downloadUrl, { headers: { 'User-Agent': UA } })
  if (!response.ok) throw new Error(`Gagal mengunduh media (${response.status})`)
  const mimetype = response.headers.get('content-type') || info.mimetype || 'application/octet-stream'
  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)
  const bytes = await streamToFile(response.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}
