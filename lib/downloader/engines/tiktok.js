// lib/downloader/engines/tiktok.js
//
// Engine murni untuk TikTok — adaptasi SETIA legacy
// plugins/downloader-tiktok.js (versi yang teruji live oleh pemilik),
// menggantikan TOTAL engine instatiktok sebelumnya (2026-10-24: probe
// 0/5 — instatiktok gagal resolve, sisanya gugur di HEAD check).
//
// Alur legacy, dipertahankan persis:
//   1. savetikDownloader dulu; kalau gagal/tanpa media -> TikWM.
//   2. Urutan diulang sampai 3 ronde (legacy: retry luar 3x; retry dalam
//      per-resolver dilebur ke ronde ini supaya total percobaan bounded).
//   3. Foto didahulukan atas video (legacy return dini setelah foto).
//   4. Video utama = SD dulu (legacy mengirim videoSD, HD hanya on-demand
//      lewat balasan 'hd'); HD dipakai hanya bila SD tidak ada.
//   5. Foto >1 -> list bermediaItems agar runJob mengirim album (padanan
//      sendAlbum legacy); foto tunggal -> file tunggal.
//
// Pelajaran dari probe yang GAGAL dan sengaja TIDAK dibawa ke sini:
//   - TIDAK ADA HEAD check media. HEAD dari VM terbukti tak bisa dipegang:
//     tikwm lolos resolve tapi HEAD 503, savetik/tikdownloader lolos
//     resolve tapi HEAD timeout — padahal URL-nya hidup (legacy yang
//     langsung sendFile tanpa HEAD jalan normal). Legacy tidak pernah
//     HEAD media, dan engine ini juga tidak.
//   - instatiktok, widipe, tikdownloader, dlpanda DIBUANG dari engine ini.
//     Fitur follow-up legacy ('balas hd' / 'mp3') adalah perilaku plugin
//     interaktif, bukan engine satu-file .dl — tidak ikut ke sini.
//
// Catatan: URL pendek vt.tiktok.com diteruskan apa adanya ke API resolver,
// persis seperti legacy (tidak perlu resolve redirect dulu).

import path from 'node:path'
import { load } from 'cheerio'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'

export const id = 'tiktok'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function retry(fn, max = 3) {
  let lastErr
  for (let i = 0; i < max; i++) {
    try { return await fn() } catch (e) { lastErr = e; if (i < max - 1) await sleep(1500) }
  }
  throw lastErr
}

function fixTikwmUrl(url) {
  if (!url) return null
  if (url.startsWith('http')) return url
  return 'https://www.tikwm.com' + url
}

const hasMedia = r => (r.images?.length ?? 0) > 0 || !!r.videoSD || !!r.videoHD

/** savetikDownloader legacy: POST ajaxSearch -> HTML -> parse cheerio. */
export async function savetikResolver(url, { fetchFn = fetch } = {}) {
  const res = await fetchFn('https://savetik.io/api/ajaxSearch', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      referer: 'https://savetik.io/en/download-tiktok-photos',
    },
    body: new URLSearchParams({ q: url, cursor: '0', page: '0', lang: 'en' }),
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error(`savetik merespons status ${res.status}.`)
  const data = await res.json().catch(() => null)
  if (!data || data.status !== 'ok') throw new Error('savetik gagal mengambil data.')
  const $ = load(data.data)
  const title = $('h3').first().text().trim() || 'TikTok'
  const photos = []
  $('.photo-list .download-items').each((_, el) => {
    const href = $(el).find('a').attr('href')?.replace(/&amp;/g, '&')
    if (href) photos.push(href)
  })
  let videoHD = null, videoSD = null, audio = null
  $('.dl-action a').each((_, el) => {
    const text = $(el).text()
    const href = $(el).attr('href')?.replace(/&amp;/g, '&')
    if (!href) return
    if (/Download MP4 HD/i.test(text)) videoHD = href
    else if (/Download MP4 \[2\]/i.test(text)) { if (!videoHD) videoHD = href; if (!videoSD) videoSD = href }
    else if (/Download MP4 \[1\]/i.test(text)) videoSD = href
    else if (/Download MP3/i.test(text)) audio = href
  })
  return { title, images: photos, videoSD, videoHD, audio }
}

/** TikWM legacy: POST api -> JSON { code, data: { play, hdplay, music, images } }. */
export async function tikwmResolver(url, { fetchFn = fetch } = {}) {
  const res = await fetchFn('https://www.tikwm.com/api/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ url, hd: 1 }),
    signal: AbortSignal.timeout(90000),
  })
  if (!res.ok) throw new Error(`tikwm merespons status ${res.status}.`)
  const data = await res.json().catch(() => null)
  if (!data || data.code !== 0) throw new Error(`tikwm gagal mengambil data (code ${data?.code}).`)
  const d = data.data
  return {
    title: d.title || 'TikTok',
    images: d.images || [],
    videoSD: fixTikwmUrl(d.play),
    videoHD: fixTikwmUrl(d.hdplay),
    audio: fixTikwmUrl(d.music),
  }
}

/**
 * Urutan legacy: savetik dulu, tikwm sebagai fallback. Satu resolver yang
 * mengembalikan TANPA media dihitung gagal (legacy punya celah ini: sukses
 * kosong lalu tidak ada yang terkirim) sehingga fallback tetap jalan.
 */
export async function resolveTiktok(url, { fetchFn = fetch } = {}) {
  return retry(async () => {
    let res = null, lastErr = null
    try {
      res = await savetikResolver(url, { fetchFn })
      if (hasMedia(res)) return res
      lastErr = new Error('savetik tidak mengembalikan media.')
    } catch (e) { lastErr = e }
    try {
      res = await tikwmResolver(url, { fetchFn })
      if (hasMedia(res)) return res
      lastErr = new Error('tikwm tidak mengembalikan media.')
    } catch (e) { lastErr = e }
    throw lastErr
  })
}

export function match(url = '') {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    return host === 'tiktok.com' || host.endsWith('.tiktok.com')
  } catch { return false }
}

export async function getInfo(url, { fetchFn = fetch } = {}) {
  const res = await resolveTiktok(url, { fetchFn })
  if (res.images?.length > 1) {
    const items = res.images.map((link, i) => ({ fileName: `tiktok-${i + 1}`, downloadUrl: link }))
    return {
      isList: true,
      fileName: 'TikTok',
      size: null,
      files: items.map(it => ({ fileName: it.fileName, size: null })),
      mediaItems: items,
    }
  }
  if (res.images?.length === 1) {
    return { fileName: 'tiktok-1', size: null, mimetype: null, downloadUrl: res.images[0] }
  }
  // Video: SD dulu (legacy), HD hanya bila SD tidak ada.
  const video = res.videoSD || res.videoHD
  if (!video) throw new Error('Resolver TikTok tidak mengembalikan media.')
  return { fileName: 'tiktok.mp4', size: null, mimetype: 'video/mp4', downloadUrl: video }
}

export async function download(url, info, { destDir, baseName, maxBytes, fetchFn = fetch } = {}) {
  if (!info?.downloadUrl) throw new Error('Info TikTok tidak membawa link unduhan.')
  const response = await retry(async () => {
    const r = await fetchFn(info.downloadUrl, { headers: { 'User-Agent': UA } })
    if (!r.ok) throw new Error(`Gagal mengunduh media (${r.status})`)
    return r
  })
  const mimetype = response.headers.get('content-type') || info.mimetype || 'application/octet-stream'
  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)
  const bytes = await streamToFile(response.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}
