// lib/downloader/engines/mp4upload.js
//
// Diporting dari legacy lib/downloader/engines/mp4upload.js (konsolidasi
// omp4upload). mp4upload butuh 2x request form-post (download1 lalu
// download2) sebelum dapat link CDN langsungnya — semua itu masih
// tergolong "metadata phase", jadi semua masuk getInfo().
//
// Legacy memakai axios + axios-cookiejar-support + cheerio; di sini
// diganti fetch global + jar cookie manual + regex untuk membaca
// <input name="fname"> / <input name="id"> dari form halaman — hasilnya
// sama, tanpa dependensi baru.

import path from 'node:path'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'

export const id = 'mp4upload'

const UA = 'Mozilla/5.0'
const REFERER = 'https://www.mp4upload.com/'
const INFO_TIMEOUT_MS = 30 * 1000

export function match(url = '') {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    return host === 'mp4upload.com' || host.endsWith('.mp4upload.com')
  } catch { return false }
}

/** Jar cookie minimal: simpan pasangan nama=nilai dari Set-Cookie. */
function createCookieJar() {
  const jar = new Map()
  return {
    absorb(res) {
      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
      for (const sc of setCookies) {
        const pair = sc.split(';')[0]
        const i = pair.indexOf('=')
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
      }
    },
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    }
  }
}

function inputValue(html, name) {
  for (const tag of html.match(/<input[^>]*>/gi) ?? []) {
    const nameM = tag.match(/name\s*=\s*"([^"]*)"/i) || tag.match(/name\s*=\s*'([^']*)'/i)
    if (nameM?.[1] !== name) continue
    const valM = tag.match(/value\s*=\s*"([^"]*)"/i) || tag.match(/value\s*=\s*'([^']*)'/i)
    if (valM) return valM[1]
  }
  return null
}

async function scrapeMp4Upload(url, jar, fetchFn) {
  const res = await fetchFn(url, {
    headers: { 'User-Agent': UA, Referer: REFERER, ...(jar.header() ? { Cookie: jar.header() } : {}) },
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS)
  })
  jar.absorb(res)
  if (!res.ok) throw new Error(`Gagal membuka halaman mp4upload (${res.status})`)
  const html = await res.text()

  const fileName = inputValue(html, 'fname') || html.match(/<h4[^>]*>([^<]+)<\/h4>/i)?.[1]?.trim()
  const fileId = inputValue(html, 'id')
  if (!fileId || !fileName) throw new Error('Gagal mengambil metadata mp4upload (link mungkin sudah tidak valid).')

  return { fileId, fileName }
}

async function postForm(url, jar, fetchFn, fields, { manualRedirect = false } = {}) {
  const form = new URLSearchParams()
  for (const [k, v] of fields) form.append(k, v)
  const res = await fetchFn(url, {
    method: 'POST',
    redirect: manualRedirect ? 'manual' : 'follow',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Referer: url,
      ...(jar.header() ? { Cookie: jar.header() } : {})
    },
    body: form.toString(),
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS)
  })
  jar.absorb(res)
  return res
}

export async function getInfo(url, { fetchFn = fetch } = {}) {
  const jar = createCookieJar()
  const meta = await scrapeMp4Upload(url, jar, fetchFn)

  // download1 wajib dipanggil sebelum download2 (urutan dari legacy).
  await postForm(url, jar, fetchFn, [
    ['op', 'download1'],
    ['id', meta.fileId],
    ['fname', meta.fileName],
    ['method_free', 'Free Download']
  ])

  const res2 = await postForm(url, jar, fetchFn, [
    ['op', 'download2'],
    ['id', meta.fileId],
    ['method_free', 'Free Download'],
    ['referer', url]
  ], { manualRedirect: true })

  const directUrl = res2.headers.get('location')
  if (!directUrl) throw new Error('Gagal mendapatkan redirect link mp4.')

  let size = null
  try {
    const head = await fetchFn(directUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': UA, Referer: REFERER },
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS)
    })
    size = parseInt(head.headers.get('content-length') || '0', 10) || null
  } catch {
    // gak semua CDN mp4upload ngasih respon ke HEAD, gak fatal
  }

  return { fileName: meta.fileName, size, directUrl }
}

export async function download(url, info, { destDir, baseName, maxBytes, fetchFn = fetch } = {}) {
  const response = await fetchFn(info.directUrl, {
    headers: { 'User-Agent': UA, Referer: REFERER }
  })
  if (!response.ok) throw new Error(`Gagal mengunduh file (${response.status})`)

  const mimetype = response.headers.get('content-type') || 'video/mp4'
  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)

  const bytes = await streamToFile(response.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}
