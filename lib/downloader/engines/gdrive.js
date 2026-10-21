// lib/downloader/engines/gdrive.js
//
// Diporting dari legacy lib/downloader/engines/gdrive.js (konsolidasi
// ogdrive/ogdrive2/ogdrive3, logic ogdrive2 sebagai acuan), ditulis ulang
// dari node-fetch ke fetch global. Perbaikan kecil legacy tetap
// dipertahankan: downloadUrl hanya di-fetch satu kali di download()
// (respons final dipakai untuk baca mimetype DAN stream ke disk), dan
// token konfirmasi Google di-resolve sebelum streaming.

import path from 'node:path'
import { buildFileName, getExtFromMime } from '../mime.js'
import { streamToFile } from '../stream.js'

export const id = 'gdrive'

const INFO_TIMEOUT_MS = 30 * 1000

export function match(url = '') {
  try {
    const u = new URL(String(url))
    const host = u.hostname.toLowerCase()
    return host === 'drive.google.com' || (host.endsWith('.googleusercontent.com') && u.pathname.includes('/download'))
  } catch { return false }
}

function extractFileId(url) {
  const m = String(url).match(/\/d\/([^/?#]+)/) || String(url).match(/[?&]id=([^&#]+)/)
  if (!m?.[1]) throw new Error('URL Google Drive tidak valid.')
  return m[1]
}

async function fetchMetaJson(url, fetchFn) {
  const fileId = extractFileId(url)

  const res = await fetchFn(`https://drive.google.com/uc?id=${fileId}&authuser=0&export=download`, {
    method: 'POST',
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    headers: {
      'accept-encoding': 'gzip, deflate, br',
      'content-length': 0,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      origin: 'https://drive.google.com',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/65.0.3325.181 Safari/537.36',
      'x-client-data': 'CKG1yQEIkbbJAQiitskBCMS2yQEIqZ3KAQioo8oBGLeYygE=',
      'x-drive-first-party': 'DriveWebUi',
      'x-json-requested': 'true'
    }
  })

  const { fileName, sizeBytes, downloadUrl } = JSON.parse((await res.text()).slice(4))
  if (!downloadUrl) throw new Error('Link Download Limit! (kuota harian Google Drive untuk file ini habis)')

  return { fileName, sizeBytes, downloadUrl }
}

/**
 * Metadata only — gak nyentuh body file sama sekali (cuma 1 request POST
 * ringan ke endpoint uc?id=...).
 */
export async function getInfo(url, { fetchFn = fetch } = {}) {
  const meta = await fetchMetaJson(url, fetchFn)
  return {
    fileName: meta.fileName,
    size: meta.sizeBytes ? parseInt(meta.sizeBytes, 10) : null,
    downloadUrl: meta.downloadUrl
  }
}

/**
 * Resolve confirm-token (kalau Google ngebalikin halaman HTML konfirmasi
 * dulu) lalu kembalikan response final yang siap di-stream ke disk.
 */
async function fetchFinalResponse(downloadUrl, fetchFn) {
  let res = await fetchFn(downloadUrl)

  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('text/html')) {
    const text = await res.text()
    const confirm = text.match(/confirm=([0-9A-Za-z_]+)&/)
    if (confirm) {
      res = await fetchFn(`${downloadUrl}&confirm=${confirm[1]}`)
    }
  }

  if (!res.ok) throw new Error(res.statusText || `HTTP ${res.status}`)
  return res
}

export async function download(url, info, { destDir, baseName, maxBytes, fetchFn = fetch } = {}) {
  const res = await fetchFinalResponse(info.downloadUrl, fetchFn)

  let mimetype = res.headers.get('content-type') || 'application/octet-stream'
  if (mimetype === 'application/octet-stream') mimetype = 'application/x-rar-compressed'

  // Koreksi heuristik: Drive sering ngebalikin mimetype generik utk file besar.
  if (info.fileName?.endsWith('.mkv') && mimetype === 'application/x-rar-compressed') mimetype = 'video/x-matroska'
  if (info.fileName?.endsWith('.pdf') && mimetype === 'application/x-rar-compressed') mimetype = 'application/pdf'
  if (info.fileName?.endsWith('.mp4') && mimetype === 'text/html') mimetype = 'video/mp4'

  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)

  const bytes = await streamToFile(res.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}

export { getExtFromMime }
