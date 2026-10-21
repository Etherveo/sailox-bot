// lib/downloader/engines/pinterest.js
//
// Engine murni untuk Pinterest (pin video/gambar). Diporting dari legacy
// plugins/downloader-pindl2.js (varian paling bersih dari tiga versi
// pindl/pinterest di legacy): resolver steptodown.com — token CSRF diambil
// dari halaman tool-nya, lalu POST wp-json/aio-dl/video-data mengembalikan
// JSON { title, medias: [{ url, extension, formattedSize }] }. Video (mp4)
// didahulukan seperti legacy, else gambar terbesar. Link pin.it ikut
// diterima: resolver menyelesaikannya di sisi mereka.

import path from 'node:path'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'

export const id = 'pinterest'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
const INFO_TIMEOUT_MS = 30 * 1000
const BASE = 'https://steptodown.com'

export function match(url = '') {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    // pinterest.<tld> atau pinterest.<tld dua bagian> (co.uk dst.), di label
    // mana pun sebelum suffix itu — menolak domain peniru ala
    // "pinterest.com.evil.test" yang hanya mengandung teksnya.
    return host === 'pin.it' || /(^|\.)pinterest\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host)
  } catch { return false }
}

export function extractStepToken(html) {
  return String(html).match(/name\s*=\s*"token"\s+value\s*=\s*"([^"]+)"/)?.[1] ?? null
}

export function parseSizeText(text) {
  const m = String(text ?? '').replace(',', '.').match(/([\d.]+)\s*(B|KB|MB|GB)/i)
  if (!m) return null
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2].toUpperCase()]
  return Math.round(parseFloat(m[1]) * mult)
}

export function pickMedia(medias) {
  if (!Array.isArray(medias) || !medias.length) return null
  const bySize = (a, b) => (parseSizeText(b.formattedSize) ?? 0) - (parseSizeText(a.formattedSize) ?? 0)
  const video = medias.filter(m => /mp4/i.test(m.extension ?? '')).sort(bySize)[0]
  if (video) return video
  return medias.filter(m => /jpe?g|png|webp/i.test(m.extension ?? '')).sort(bySize)[0] ?? medias[0]
}

export async function resolvePinterest(url, { fetchFn = fetch } = {}) {
  const pageRes = await fetchFn(`${BASE}/pinterest-video-downloader/`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) })
  if (!pageRes.ok) throw new Error(`steptodown merespons status ${pageRes.status}.`)
  const token = extractStepToken(await pageRes.text())
  if (!token) throw new Error('Token steptodown tidak ditemukan (halaman berubah).')
  const res = await fetchFn(`${BASE}/wp-json/aio-dl/video-data/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'User-Agent': UA, origin: BASE, referer: `${BASE}/pinterest-video-downloader/` },
    body: new URLSearchParams({ url, token }),
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`steptodown video-data merespons status ${res.status}.`)
  const json = await res.json().catch(() => null)
  if (!json || !Array.isArray(json.medias) || !json.medias.length) throw new Error('Media Pinterest tidak ditemukan dari resolver.')
  return json
}

function slug(text) {
  return String(text || 'pinterest').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 60) || 'pinterest'
}

export async function getInfo(url, { fetchFn = fetch } = {}) {
  const data = await resolvePinterest(url, { fetchFn })
  const media = pickMedia(data.medias)
  if (!media?.url) throw new Error('Media Pinterest tidak ditemukan.')
  const ext = (media.extension || path.extname(new URL(media.url).pathname).slice(1) || 'bin').toLowerCase()
  return {
    fileName: `${slug(data.title)}.${ext}`,
    size: parseSizeText(media.formattedSize),
    mimetype: ext === 'mp4' ? 'video/mp4' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg',
    downloadUrl: media.url,
  }
}

export async function download(url, info, { destDir, baseName, maxBytes, fetchFn = fetch } = {}) {
  if (!info?.downloadUrl) throw new Error('Info Pinterest tidak membawa link unduhan.')
  const response = await fetchFn(info.downloadUrl, { headers: { 'User-Agent': UA } })
  if (!response.ok) throw new Error(`Gagal mengunduh media (${response.status})`)
  const mimetype = response.headers.get('content-type') || info.mimetype || 'application/octet-stream'
  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)
  const bytes = await streamToFile(response.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}
