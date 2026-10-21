// lib/downloader/engines/twitter.js
//
// Engine murni untuk Twitter/X. Legacy (downloader-twitter.js) memakai
// API di domain pribadi my.ponta.dpdns.org ("Sailox API") — satu titik
// rapuh. Engine ini membalik prioritasnya:
//   1. vxtwitter API publik (api.vxtwitter.com/<user>/status/<id>) —
//      JSON berisi media_extended, tanpa kunci, jauh lebih stabil.
//   2. API legacy ponta sebagai cadangan (bentuk respons persis legacy).
// Tweet multi-media menjadi pola list (#item=<n>, 1-based); satu media
// langsung diunduh. Video mengambil URL varian dari resolver apa adanya.

import path from 'node:path'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'

export const id = 'twitter'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
const INFO_TIMEOUT_MS = 30 * 1000

export function match(url = '') {
  try {
    const u = new URL(String(url))
    const host = u.hostname.toLowerCase()
    return (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) && /\/status\/\d+/.test(u.pathname)
  } catch { return false }
}

function statusIdOf(url) {
  return String(url).match(/\/status\/(\d+)/)?.[1] ?? 'tweet'
}

export function parseVxTwitter(json) {
  const media = Array.isArray(json?.media_extended) ? json.media_extended : []
  const items = media
    .filter(m => m?.url)
    .map(m => ({ type: m.type === 'video' || m.type === 'gif' ? 'video' : 'photo', url: m.url }))
  return { items, text: json?.text ?? '', author: json?.user_name ?? '' }
}

export function parsePonta(json) {
  if (!json || json.status !== 'success') return { items: [] }
  const items = (Array.isArray(json.media) ? json.media : [])
    .filter(m => m?.url || m?.play || m?.hdplay)
    .map(m => ({ type: m.type === 'video' ? 'video' : 'photo', url: m.url || m.play || m.hdplay }))
  return { items, text: json.text ?? '', author: json.author?.name ?? '' }
}

export async function resolveTwitter(url, { fetchFn = fetch } = {}) {
  try {
    const u = new URL(url)
    const res = await fetchFn(`https://api.vxtwitter.com${u.pathname}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) })
    if (res.ok) {
      const parsed = parseVxTwitter(await res.json().catch(() => null))
      if (parsed.items.length) return parsed
    }
  } catch { /* jatuh ke resolver legacy */ }
  try {
    const res = await fetchFn(`https://my.ponta.dpdns.org/api/downloader/twitter?url=${encodeURIComponent(url)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) })
    if (res.ok) {
      const parsed = parsePonta(await res.json().catch(() => null))
      if (parsed.items.length) return parsed
    }
  } catch { /* kedua resolver gagal */ }
  return { items: [] }
}

export async function getInfo(url, { fetchFn = fetch } = {}) {
  const { items } = await resolveTwitter(url, { fetchFn })
  if (!items.length) throw new Error('Media tidak ditemukan dari tweet ini (mungkin tanpa media, terhapus, atau kedua resolver gagal).')
  const sid = statusIdOf(url)
  const named = items.map((it, i) => ({ ...it, fileName: `twitter-${sid}-${i + 1}.${it.type === 'video' ? 'mp4' : 'jpg'}` }))
  const itemMatch = String(url).match(/#item=(\d+)/)
  if (named.length > 1 && !itemMatch) {
    return { isList: true, fileName: `Tweet ${sid}`, size: null, files: named.map(n => ({ fileName: n.fileName, size: null })) }
  }
  const index = itemMatch ? Number(itemMatch[1]) - 1 : 0
  const item = named[index]
  if (!item) throw new Error(`Item tidak valid. Total item: ${named.length}`)
  return {
    fileName: item.fileName,
    size: null,
    mimetype: item.type === 'video' ? 'video/mp4' : 'image/jpeg',
    downloadUrl: item.url,
    ...(named.length > 1 ? { isList: true, itemIndex: index + 1, listSize: named.length } : {}),
  }
}

export async function download(url, info, { destDir, baseName, maxBytes, fetchFn = fetch } = {}) {
  if (!info?.downloadUrl) throw new Error('Info Twitter tidak membawa link unduhan.')
  const response = await fetchFn(info.downloadUrl, { headers: { 'User-Agent': UA } })
  if (!response.ok) throw new Error(`Gagal mengunduh media (${response.status})`)
  const mimetype = response.headers.get('content-type') || info.mimetype || 'application/octet-stream'
  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)
  const bytes = await streamToFile(response.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}
