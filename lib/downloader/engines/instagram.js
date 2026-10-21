// lib/downloader/engines/instagram.js
//
// Engine murni untuk Instagram (post/reel). Mekanismenya diganti total
// pada 2026-10-21 mengikuti legacy plugins/downloader-download.js (versi
// yang menurut pemilik benar-benar bekerja): resolver bersama
// instatiktok.com — lihat lib/downloader/instatiktok.js. Setia legacy,
// SEMUA tautan hasil resolver adalah file postingan: lebih dari satu ->
// pola list (#item=<n>, 1-based), satu -> langsung diunduh. Resolver lama
// (downloadgram/diioffc) dibuang karena error di lapangan.

import path from 'node:path'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'
import { resolveInstaTiktok } from '../instatiktok.js'

export const id = 'instagram'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

export function match(url = '') {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    return host === 'instagram.com' || host.endsWith('.instagram.com')
  } catch { return false }
}

// Tautan hasil instatiktok berbentuk /force-download.php?url=<base64> —
// nama & tipe asli TIDAK terbaca dari tautannya (token base64 di dalamnya
// adalah JWT rapidcdn, tapi mengandalkannya rapuh). Nama generik per
// indeks dipakai; ekstensi/mime final ditentukan konten unduhannya di
// download() (buildFileName membetulkan ekstensi dari content-type).
function fileNameFor(link, index) {
  return `instagram-${index + 1}`
}

function mimeOf(fileName) {
  const ext = path.extname(fileName ?? '').slice(1).toLowerCase()
  return { mp4: 'video/mp4', mov: 'video/quicktime', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext] ?? null
}

export async function getInfo(url, { fetchFn = fetch } = {}) {
  const links = await resolveInstaTiktok('instagram', url, { fetchFn })
  const named = links.map((link, i) => ({ url: link, fileName: fileNameFor(link, i) }))
  const itemMatch = String(url).match(/#item=(\d+)/)
  if (named.length > 1 && !itemMatch) {
    return { isList: true, fileName: 'Postingan Instagram', size: null, files: named.map(n => ({ fileName: n.fileName, size: null })) }
  }
  const index = itemMatch ? Number(itemMatch[1]) - 1 : 0
  const item = named[index]
  if (!item) throw new Error(`Item tidak valid. Total item: ${named.length}`)
  return {
    fileName: item.fileName,
    size: null,
    mimetype: mimeOf(item.fileName),
    downloadUrl: item.url,
    ...(named.length > 1 ? { isList: true, itemIndex: index + 1, listSize: named.length } : {}),
  }
}

export async function download(url, info, { destDir, baseName, maxBytes, fetchFn = fetch } = {}) {
  if (!info?.downloadUrl) throw new Error('Info Instagram tidak membawa link unduhan.')
  const response = await fetchFn(info.downloadUrl, { headers: { 'User-Agent': UA } })
  if (!response.ok) throw new Error(`Gagal mengunduh media (${response.status})`)
  const mimetype = response.headers.get('content-type') || info.mimetype || 'application/octet-stream'
  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)
  const bytes = await streamToFile(response.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}
