// lib/downloader/engines/pinterest.js
//
// Engine murni untuk Pinterest (pin video/gambar/carousel). Diporting dari
// legacy plugins/downloader-pindl.js: scrape LANGSUNG halaman pin (pin.it
// di-follow redirect-nya oleh fetch), TANPA resolver pihak ketiga.
//
// Versi sebelumnya memakai resolver steptodown (port dari legacy pindl2)
// dan RUSAK di lapangan: resolver mengembalikan HTML (DOCTYPE) bukan
// JSON — persis error legacy "Unexpected token '<', "<!DOCTYPE "...".
// Perbaikan vs legacy pindl: prioritas gambar diubah — images_orig dulu,
// baru 736x/474x, lalu imageLargeUrl (di beberapa pin imageLargeUrl hanya
// thumbnail 140x140), terakhir og:image.

import path from 'node:path'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'

export const id = 'pinterest'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const INFO_TIMEOUT_MS = 30 * 1000

export function match(url = '') {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    // pinterest.<tld> atau pinterest.<tld dua bagian> (co.uk dst.), di label
    // mana pun sebelum suffix itu — menolak domain peniru ala
    // "pinterest.com.evil.test" yang hanya mengandung teksnya.
    return host === 'pin.it' || /(^|\.)pinterest\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host)
  } catch { return false }
}

const unescape = s => String(s ?? '').replaceAll('\\/', '/')

function decodeTitle(raw) {
  try {
    return JSON.parse(`"${String(raw ?? '').replace(/"/g, '\\"')}"`)
  } catch { return String(raw ?? '') }
}

function slug(text) {
  return String(text || 'pinterest').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 60) || 'pinterest'
}

function extOf(url) {
  try {
    return path.extname(new URL(url).pathname).slice(1).toLowerCase() || 'jpg'
  } catch { return 'jpg' }
}

function mimeOfExt(ext) {
  return { mp4: 'video/mp4', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] ?? 'image/jpeg'
}

// Parser halaman pin, dipisah dari getInfo supaya bisa dites tanpa fetch.
// Bentuk hasil meniru legacy pindl: video | slide (carousel) | single.
export function parsePinPage(html = '') {
  const src = String(html)
  const get = regex => {
    const m = src.match(regex)
    return m ? m[1] : null
  }
  const rawTitle =
    get(/"seoTitle":"([^"]+)"/) ||
    get(/"gridTitle":"([^"]+)"/) ||
    get(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) || ''
  const title = decodeTitle(rawTitle).replace(/^\[Video\]\s*/i, '').trim()

  const hasVideo = /"StoryPinVideoBlock"/.test(src) || /"videoDataV2"/.test(src) || /v1\.pin(?:img)?\.com\/videos/.test(src)
  const hasCarousel = /"carouselData":\{"carouselSlots":\[/.test(src)

  if (hasVideo) {
    const rawVideoUrl =
      get(/"url":"(https?:\\?\/\\?\/v1\.pin(?:img)?\.com\\?\/videos\\?[^"]+\.mp4)"/) ||
      get(/"videoList720P":\{"v720P":\{[^}]*"url":"([^"]+)"/) ||
      get(/"videoListMobile":\{"vHLSV3MOBILE":\{[^}]*"url":"([^"]+)"/) ||
      get(/"vHLSV4":\{[^}]*"url":"([^"]+)"/) ||
      get(/"contentUrl":"([^"]+\.mp4)"/)
    return { type: 'video', title, videoUrl: rawVideoUrl ? unescape(rawVideoUrl) : null }
  }

  if (hasCarousel) {
    const images = [...src.matchAll(
      /"images_1200x":\{"height":(\d+),"url":"([^"]+)","width":(\d+)\}/g,
    )].map((m, i) => ({ index: i + 1, url: unescape(m[2]) }))
    return { type: 'slide', title, images }
  }

  // Urutan prioritas: orig (ukuran penuh) > 736x > 474x > imageLargeUrl
  // (kadang hanya thumbnail 140x140) > og:image.
  const rawImage =
    get(/"images_orig":\{[\s\S]*?"url":"([^"]+)"/) ||
    get(/"images_736x":\{"url":"([^"]+)"/) ||
    get(/"images_474x":\{"url":"([^"]+)"/) ||
    get(/"imageLargeUrl":"([^"]+)"/) ||
    get(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
  return { type: 'single', title, images: rawImage ? [{ index: 1, url: unescape(rawImage) }] : [] }
}

export async function getInfo(url, { fetchFn = fetch } = {}) {
  const res = await fetchFn(url, {
    redirect: 'follow',
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Pinterest merespons status ${res.status}.`)
  const data = parsePinPage(await res.text())
  const title = slug(data.title)

  if (data.type === 'video') {
    if (!data.videoUrl) throw new Error('URL video Pinterest tidak ditemukan.')
    return { fileName: `${title}.mp4`, size: null, mimetype: 'video/mp4', downloadUrl: data.videoUrl }
  }

  if (data.type === 'slide') {
    if (!data.images.length) throw new Error('Gambar slide Pinterest tidak ditemukan.')
    const named = data.images.map((img, i) => {
      const ext = extOf(img.url)
      return { fileName: `${title}-${i + 1}.${ext}`, downloadUrl: img.url }
    })
    const itemMatch = String(url).match(/#item=(\d+)/)
    if (!itemMatch) {
      return {
        isList: true,
        fileName: title,
        size: null,
        files: named.map(n => ({ fileName: n.fileName, size: null })),
        mediaItems: named,
      }
    }
    const index = Number(itemMatch[1]) - 1
    const item = named[index]
    if (!item) throw new Error(`Item tidak valid. Total item: ${named.length}`)
    return {
      fileName: item.fileName,
      size: null,
      mimetype: mimeOfExt(extOf(item.downloadUrl)),
      downloadUrl: item.downloadUrl,
      isList: true, itemIndex: index + 1, listSize: named.length,
    }
  }

  if (!data.images.length) throw new Error('Gambar Pinterest tidak ditemukan.')
  const ext = extOf(data.images[0].url)
  return { fileName: `${title}.${ext}`, size: null, mimetype: mimeOfExt(ext), downloadUrl: data.images[0].url }
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
