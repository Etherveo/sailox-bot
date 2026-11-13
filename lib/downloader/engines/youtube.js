// lib/downloader/engines/youtube.js
//
// Engine YouTube (audio mp3 + video mp4). Diporting dari legacy:
//   - pencarian: plugins/downloader-play.js (InnerTube search POST,
//     tanpa yt-search — paket itu tidak ada di bot baru)
//   - unduhan: plugins/downloader-play.js + downloader-yta.js
//     (savetube.vip: random-cdn -> /v2/info -> /download, dengan
//     dekripsi AES-128-CBC atas respons /v2/info)
//
// Audio: downloadType 'audio', quality '128' -> mp3. Video:
// downloadType 'video', quality 360/480/720/1080 -> mp4 (dibuktikan
// probe 2026-11-14: 720p video 3:34 = 21 MB, 360p = 9 MB, 480p dan
// 1080p juga mengembalikan downloadUrl). Jenis + resolusi video
// dibawa di fragmen URL job (#yt=video:720) — fragmen membuat job
// audio dan video untuk link yang sama dianggap job berbeda oleh
// dedupe antrean (yang mengunci pada string URL persis), dan engine
// membaca kembali fragmen itu di getInfo. Tanpa fragmen, jenisnya
// audio (perilaku .play/.unduh yang sudah ada).
//
// Ukuran file: /v2/info savetube TIDAK memberi ukuran — diukur lewat
// HEAD pada downloadUrl, lalu (bila HEAD gagal/tanpa length) lewat
// GET rentang 1 byte (content-range). Keduanya tidak bisa dipegang
// (probe: HEAD kadang 'fetch failed') — bila ukuran tetap tidak
// diketahui, getInfo mengembalikan size null dan batas ukuran
// ditegakkan sesudah unduh, sebelum kirim (lihat runJob.js).
//
// Jalur yang TIDAK dipakai (mati dari VM, dibuktikan probe 2026-11-14):
//   - p.oceansaver.in (scraper/ytdl.js): host tidak bisa dihubungi sama
//     sekali (curl HTTP 000) — API key legacy-nya TIDAK disalin.
//   - yt-dlp: tidak terpasang di VM.
//   - clipto.com (src/database/ytdl.js): hidup, tapi hanya jadi cadangan
//     — savetube memberi link media langsung.
//
// Kunci dekripsi di bawah adalah kunci protokol klien-web savetube
// (bukan kredensial pengguna), polanya sama seperti KURAMA_MAGIC di
// lib/kuramanime/core.js.

import path from 'node:path'
import crypto from 'node:crypto'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'

export const id = 'youtube'

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36'
const SAVETUBE_REFERER = 'https://save-tube.com/'
const INFO_TIMEOUT_MS = 30 * 1000
const AUDIO_QUALITY = '128'

// Kunci protokol savetube (lihat header file).
const SAVETUBE_SECRET_KEY = 'C5D58EF67A7584E4A29F6C35BBC4EB12'

const YT_HOSTS = /^((www|m|music)\.)?youtube\.com$|^youtu\.be$|^www\.youtube-nocookie\.com$/

const VIDEO_ID_RES = [
  /(?:youtube\.com|music\.youtube\.com|youtube-nocookie\.com)\/.*[?&]v=([A-Za-z0-9_-]{11})/,
  /(?:youtube\.com|music\.youtube\.com|youtube-nocookie\.com)\/(?:embed|v|shorts|live)\/([A-Za-z0-9_-]{11})/,
  /youtu\.be\/([A-Za-z0-9_-]{11})/,
]

export function extractVideoId(url = '') {
  const s = String(url)
  for (const re of VIDEO_ID_RES) {
    const m = s.match(re)
    if (m) return m[1]
  }
  return null
}

export function match(url = '') {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    if (!YT_HOSTS.test(host)) return false
    return extractVideoId(url) !== null
  } catch { return false }
}

// Resolusi video yang didukung (maks 1080p — perintah pemilik).
export const VIDEO_QUALITIES = [360, 480, 720, 1080]
export const DEFAULT_VIDEO_QUALITY = 720

// Baca permintaan unduhan dari URL job: jenis (audio/video) + resolusi
// video dibawa fragmen `#yt=video:<res>` / `#yt=audio` (lihat header).
// Tanpa fragmen -> audio (perilaku lama). Resolusi di luar daftar
// diabaikan -> default 720p.
export function parseYtRequest(url = '') {
  const videoId = extractVideoId(url)
  if (!videoId) return null
  const m = String(url).match(/#yt=(video|audio)(?::(\d+))?/i)
  if (!m) return { videoId, kind: 'audio', quality: DEFAULT_VIDEO_QUALITY }
  const kind = m[1].toLowerCase()
  let quality = DEFAULT_VIDEO_QUALITY
  if (kind === 'video' && m[2]) {
    const q = Number(m[2])
    if (VIDEO_QUALITIES.includes(q)) quality = q
  }
  return { videoId, kind, quality }
}

// Bangun URL job untuk antrean (fragmen dibaca getInfo; lihat header).
export function buildYtJobUrl(videoId, kind = 'audio', quality = DEFAULT_VIDEO_QUALITY) {
  const base = `https://youtu.be/${videoId}`
  return kind === 'video' ? `${base}#yt=video:${quality}` : base
}

// Resolusi video yang tersedia menurut /v2/info (video_formats):
// hanya 360-1080 (di atas itu tidak ditawarkan), tanpa duplikat,
// urut naik. Dipakai tawaran resolusi .dl.
export function availableVideoQualities(info) {
  const heights = (info?.video_formats || [])
    .map(f => Number(f?.height))
    .filter(h => VIDEO_QUALITIES.includes(h))
  return [...new Set(heights)].sort((a, b) => a - b)
}

// Dekripsi respons /v2/info savetube: 16 byte pertama = IV, sisanya isi
// terenkripsi AES-128-CBC, hasil akhirnya JSON.
export function decryptData(encryptedData) {
  const buf = Buffer.from(String(encryptedData), 'base64')
  if (buf.length <= 16) throw new Error('Data savetube tidak valid.')
  const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(SAVETUBE_SECRET_KEY, 'hex'), buf.slice(0, 16))
  const plain = Buffer.concat([decipher.update(buf.slice(16)), decipher.final()]).toString()
  return JSON.parse(plain)
}

function parseDuration(str) {
  const parts = String(str ?? '0').split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return 0
}

// Parser hasil InnerTube search, dipisah dari searchYouTube supaya bisa
// dites tanpa fetch. Mengembalikan video pertama atau null.
export function parseSearchResults(json) {
  const contents =
    json?.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents || []
  for (const section of contents) {
    for (const item of section.itemSectionRenderer?.contents || []) {
      const v = item.videoRenderer
      if (!v?.videoId) continue
      return {
        videoId: v.videoId,
        title: v.title?.runs?.map(x => x.text).join('') || '',
        url: `https://youtu.be/${v.videoId}`,
        seconds: parseDuration(v.lengthText?.simpleText || '0'),
        views: parseInt(String(v.viewCountText?.simpleText || '').replace(/[^0-9]/g, '')) || 0,
        ago: v.publishedTimeText?.simpleText || '',
        author: { name: v.ownerText?.runs?.[0]?.text || '' },
      }
    }
  }
  return null
}

async function innerTubeRequest(endpoint, data, { fetchFn = fetch } = {}) {
  const res = await fetchFn(`https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': '2.20250709.01.00',
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`YouTube merespons status ${res.status}.`)
  return res.json()
}

export async function searchYouTube(query, { fetchFn = fetch } = {}) {
  const q = String(query ?? '').trim()
  if (!q) throw new Error('Masukkan kata kunci pencarian.')
  const json = await innerTubeRequest('search', {
    context: { client: { clientName: 'WEB', clientVersion: '2.20250709.01.00' } },
    query: q,
  }, { fetchFn })
  const video = parseSearchResults(json)
  if (!video) throw new Error(`Tidak ada hasil video untuk: ${q}`)
  return video
}

// Langkah 1-2 alur savetube: pilih CDN acak, lalu /v2/info (terenkripsi).
// Mengembalikan { cdn, info } mentah (info terdekripsi).
async function savetubeInfo(videoUrl, { fetchFn = fetch } = {}) {
  const cdnRes = await fetchFn('https://media.savetube.vip/api/random-cdn', {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
  })
  if (!cdnRes.ok) throw new Error(`Savetube merespons status ${cdnRes.status}.`)
  const cdn = (await cdnRes.json())?.cdn
  if (!cdn) throw new Error('Savetube tidak mengembalikan CDN.')
  const headers = { 'User-Agent': UA, Referer: SAVETUBE_REFERER }
  const infoRes = await fetchFn(`https://${cdn}/v2/info`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: videoUrl }),
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
  })
  if (!infoRes.ok) throw new Error(`Savetube merespons status ${infoRes.status}.`)
  let info
  try {
    info = decryptData((await infoRes.json())?.data)
  } catch {
    throw new Error('Gagal membaca info video dari Savetube.')
  }
  if (!info?.key) throw new Error('Savetube tidak mengembalikan kunci unduhan.')
  return { cdn, info }
}

// Langkah 3 alur savetube: /download -> link media langsung.
async function savetubeMediaLink(cdn, key, downloadType, quality, label, { fetchFn = fetch } = {}) {
  const headers = { 'User-Agent': UA, Referer: SAVETUBE_REFERER }
  const dlRes = await fetchFn(`https://${cdn}/download`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ downloadType, quality: String(quality), key }),
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
  })
  if (!dlRes.ok) throw new Error(`Savetube merespons status ${dlRes.status}.`)
  const downloadUrl = (await dlRes.json())?.data?.downloadUrl
  if (!downloadUrl) throw new Error(`${label} tidak tersedia dari Savetube.`)
  return downloadUrl
}

// Ukur file SEBELUM unduh badan: HEAD (content-length), lalu GET rentang
// 1 byte (total dari content-range). Keduanya bisa gagal (CDN savetube
// kadang menolak HEAD) -> kembalikan null (ukuran tidak diketahui;
// penegakan batas pindah ke sesudah unduh, sebelum kirim).
export async function probeSize(downloadUrl, { fetchFn = fetch } = {}) {
  try {
    const head = await fetchFn(downloadUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': UA, Referer: SAVETUBE_REFERER },
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    })
    const len = Number(head.headers?.get?.('content-length'))
    if (Number.isFinite(len) && len > 0) return len
  } catch { /* lanjut ke GET rentang */ }
  try {
    const res = await fetchFn(downloadUrl, {
      method: 'GET',
      headers: { 'User-Agent': UA, Referer: SAVETUBE_REFERER, Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    })
    const range = res.headers?.get?.('content-range') || ''
    const m = /\/(\d+)\s*$/.exec(range)
    // Habiskan 1 byte badan supaya soket tidak menggantung.
    await res.arrayBuffer().catch(() => {})
    if (m) return Number(m[1])
    const len = Number(res.headers?.get?.('content-length'))
    if (Number.isFinite(len) && len > 0) return len
  } catch { /* ukuran tidak diketahui */ }
  return null
}

// Resolusi video yang tersedia untuk satu video (dipakai tawaran .dl).
// Gagal (savetube down) -> lempar; pemanggil yang memutuskan fallback.
export async function getVideoQualities(url, { fetchFn = fetch } = {}) {
  const req = parseYtRequest(url)
  if (!req) throw new Error('Link YouTube tidak valid.')
  const { info } = await savetubeInfo(`https://youtu.be/${req.videoId}`, { fetchFn })
  return availableVideoQualities(info)
}

// Alur audio lama (dipakai .play): /download audio 128kbps -> mp3.
async function savetubeDownloadUrl(videoUrl, { fetchFn = fetch } = {}) {
  const { cdn, info } = await savetubeInfo(videoUrl, { fetchFn })
  const downloadUrl = await savetubeMediaLink(cdn, info.key, 'audio', AUDIO_QUALITY, 'Audio', { fetchFn })
  return { downloadUrl, title: info.title || '', duration: Number(info.duration) || 0 }
}

// Alur video (.dl): coba resolusi yang diminta, lalu 720p, lalu resolusi
// tertinggi DI BAWAH yang diminta (turun). Mengembalikan info + kualitas
// yang BENAR-BENAR dipakai (bisa berbeda dari yang diminta -> fallback).
async function savetubeVideoInfo(videoId, requestedQuality, { fetchFn = fetch } = {}) {
  const { cdn, info } = await savetubeInfo(`https://youtu.be/${videoId}`, { fetchFn })
  const available = availableVideoQualities(info)
  const order = [requestedQuality]
  if (requestedQuality !== DEFAULT_VIDEO_QUALITY) order.push(DEFAULT_VIDEO_QUALITY)
  for (const q of [1080, 720, 480, 360]) {
    if (q < requestedQuality && !order.includes(q)) order.push(q)
  }
  let lastErr = null
  for (const q of order) {
    try {
      const downloadUrl = await savetubeMediaLink(cdn, info.key, 'video', q, 'Video', { fetchFn })
      const size = await probeSize(downloadUrl, { fetchFn })
      return {
        fileName: `${cleanTitle(info.title)}.mp4`,
        size,
        mimetype: 'video/mp4',
        downloadUrl,
        title: info.title || '',
        duration: Number(info.duration) || 0,
        videoId,
        kind: 'video',
        quality: q,
        requestedQuality,
        fallback: q !== requestedQuality,
        availableQualities: available,
      }
    } catch (e) { lastErr = e }
  }
  throw new Error(`Video ${requestedQuality}p tidak tersedia dari Savetube.${lastErr ? ` (${lastErr.message})` : ''}`)
}

function cleanTitle(title) {
  const cleaned = String(title || '').replace(/[\\/:*?"<>|\x00-\x1F]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150)
  return cleaned || 'youtube-audio'
}

export async function getInfo(url, { fetchFn = fetch } = {}) {
  const req = parseYtRequest(url)
  if (!req) throw new Error('Link YouTube tidak valid.')
  const videoUrl = `https://youtu.be/${req.videoId}`
  if (req.kind === 'video') return savetubeVideoInfo(req.videoId, req.quality, { fetchFn })
  const { downloadUrl, title, duration } = await savetubeDownloadUrl(videoUrl, { fetchFn })
  const size = await probeSize(downloadUrl, { fetchFn })
  return {
    fileName: `${cleanTitle(title)}.mp3`,
    size,
    mimetype: 'audio/mpeg',
    downloadUrl,
    title,
    duration,
    videoId: req.videoId,
    kind: 'audio',
  }
}

export async function download(url, info, { destDir, baseName, maxBytes, fetchFn = fetch } = {}) {
  if (!info?.downloadUrl) throw new Error('Info YouTube tidak membawa link unduhan.')
  const response = await fetchFn(info.downloadUrl, {
    headers: { 'User-Agent': UA, Referer: SAVETUBE_REFERER },
  })
  if (!response.ok) throw new Error(`Gagal mengunduh media (${response.status})`)
  const mimetype = response.headers.get('content-type') || info.mimetype || 'audio/mpeg'
  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)
  const bytes = await streamToFile(response.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}
