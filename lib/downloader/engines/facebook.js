// lib/downloader/engines/facebook.js
//
// Engine murni untuk video Facebook. Mekanismenya diganti total pada
// 2026-10-21 mengikuti legacy plugins/downloader-download.js (versi yang
// menurut pemilik benar-benar bekerja): resolver bersama instatiktok.com
// — lihat lib/downloader/instatiktok.js. Pemilihan tautan setia legacy:
// tautan TERAKHIR dari hasil resolver. Resolver lama (fbdownloader.to)
// dibuang karena error di lapangan.

import path from 'node:path'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'
import { resolveInstaTiktok } from '../instatiktok.js'

export const id = 'facebook'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
const INFO_TIMEOUT_MS = 30 * 1000

export function match(url = '') {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    return host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.watch'
  } catch { return false }
}

export async function getInfo(url, { fetchFn = fetch } = {}) {
  const links = await resolveInstaTiktok('facebook', url, { fetchFn })
  const downloadUrl = links.at(-1)
  const videoId = String(url).match(/(\d{5,})/)?.[1] ?? 'video'
  let size = null
  try {
    const head = await fetchFn(downloadUrl, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) })
    if (head.ok) size = parseInt(head.headers.get('content-length') || '0', 10) || null
  } catch { /* HEAD ditolak — lanjut tanpa ukuran pasti */ }
  return { fileName: `facebook-${videoId}.mp4`, size, mimetype: 'video/mp4', downloadUrl }
}

export async function download(url, info, { destDir, baseName, maxBytes, fetchFn = fetch } = {}) {
  if (!info?.downloadUrl) throw new Error('Info Facebook tidak membawa link unduhan.')
  const response = await fetchFn(info.downloadUrl, { headers: { 'User-Agent': UA } })
  if (!response.ok) throw new Error(`Gagal mengunduh video (${response.status})`)
  const mimetype = response.headers.get('content-type') || info.mimetype || 'video/mp4'
  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)
  const bytes = await streamToFile(response.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}
