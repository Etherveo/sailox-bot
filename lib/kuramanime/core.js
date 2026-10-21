// lib/kuramanime/core.js
//
// Port terpangkas dari proyek kuramanime standalone (kurama-core.js) —
// hanya mesin sesi + pengambil halaman episode/batch yang dibutuhkan
// resolver kDrive bot (lib/kuramanime/resolve.js). Bagian interaktif CLI
// (prompt, print, simpan JSON, dump debug) SENGAJA tidak ikut.
//
// Mekanisme konten episode/batch (3 langkah, konstan terkonfirmasi):
//   1. GET check route (#checkEp/#checkBatch) — "buka kunci" sisi server.
//   2. GET /assets/<nama acak>.txt — token dinamis per page-load.
//   3. POST ke URL halaman itu sendiri dengan param magic
//      Ub3BzhijicHXZdv=<token> & C2XAPerzX1BM7V9=kuramadrive,
//      body authorization=<token konstan> → HTML video + link unduhan.

import axios from 'axios'
import * as cheerio from 'cheerio'

export const BASE_URL = 'https://v20.kuramanime.ing'

export const KURAMA_MAGIC = {
  paramKey1: 'Ub3BzhijicHXZdv',
  paramKey2: 'C2XAPerzX1BM7V9',
  paramVal2: 'kuramadrive',
  authToken: 'kJuHHkaqcBFXiGMHQf6bJw8YAyDcwGD8Ur'
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export function createCookieJar() {
  const store = new Map()
  return {
    apply(setCookieHeader) {
      const headers = [setCookieHeader].flat().filter(Boolean)
      for (const raw of headers) {
        const pair = raw.split(';')[0]
        const idx = pair.indexOf('=')
        if (idx === -1) continue
        const name = pair.slice(0, idx).trim()
        const value = pair.slice(idx + 1).trim()
        if (name) store.set(name, value)
      }
    },
    header() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    }
  }
}

export function createSession() {
  const jar = createCookieJar()
  jar.apply([
    'sel_timezone_v2=Asia/Jakarta',
    'auto_timezone_v2=yes',
    'full_timezone_v2=+07',
    'short_timezone_v2=+07',
    'preferred_stserver=kuramadrive'
  ])
  let csrfToken = null

  const client = axios.create({
    baseURL: BASE_URL,
    timeout: 30_000,
    validateStatus: () => true,
    maxRedirects: 10
  })

  function extractCsrf(html) {
    if (typeof html !== 'string') return
    const m = html.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i)
    if (m) csrfToken = m[1]
  }

  async function rawRequest({ method, url, headers = {}, data }) {
    const cookieStr = jar.header()
    const finalHeaders = { 'User-Agent': DEFAULT_UA, ...headers }
    if (cookieStr) finalHeaders.Cookie = cookieStr

    let res
    try {
      res = await client.request({ method, url, headers: finalHeaders, data })
    } catch (err) {
      throw new Error(`Network error "${url}": ${err.code || err.message}`)
    }

    jar.apply(res.headers['set-cookie'])
    if (res.status >= 400) throw new Error(`HTTP ${res.status} untuk "${url}"`)
    extractCsrf(res.data)
    return res.data
  }

  async function get(pathOrUrl, { ajax = false } = {}) {
    const isAbsolute = /^https?:\/\//i.test(pathOrUrl)
    const url = isAbsolute ? pathOrUrl : `${BASE_URL}${pathOrUrl}`
    const headers = {
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      Accept: ajax
        ? 'application/json, text/javascript, */*; q=0.01'
        : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    }
    if (ajax) {
      headers['X-Requested-With'] = 'XMLHttpRequest'
      if (csrfToken) headers['X-CSRF-TOKEN'] = csrfToken
    }
    return rawRequest({ method: 'GET', url, headers })
  }

  async function fetchRotatingTokenValue(pageUrl) {
    const filename = randomAssetFilename()
    const url = `${BASE_URL}/assets/${filename}.txt`
    const text = await rawRequest({
      method: 'GET',
      url,
      headers: {
        Accept: 'text/plain, */*; q=0.01',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': csrfToken || '',
        Referer: pageUrl
      }
    })
    const value = typeof text === 'string' ? text.trim() : ''
    if (!value || /<html/i.test(value)) {
      throw new Error(`Gagal dapat token dinamis dari /assets/${filename}.txt`)
    }
    return value
  }

  async function fetchPageContent(pageUrl, dynamicParamValue) {
    const sep = pageUrl.includes('?') ? '&' : '?'
    const url =
      `${pageUrl}${sep}${KURAMA_MAGIC.paramKey1}=${dynamicParamValue}` +
      `&${KURAMA_MAGIC.paramKey2}=${KURAMA_MAGIC.paramVal2}&page=1`
    return rawRequest({
      method: 'POST',
      url,
      headers: {
        Accept: 'text/html, */*; q=0.01',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': csrfToken || '',
        Referer: pageUrl
      },
      data: `authorization=${KURAMA_MAGIC.authToken}`
    })
  }

  return { get, fetchPageContent, fetchRotatingTokenValue, getCsrfToken: () => csrfToken }
}

export function randomAssetFilename() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 15; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

export async function warmUp(session, log = () => {}) {
  try {
    await session.get('/')
    log('[kuramanime] Sesi & token CSRF siap.')
  } catch (err) {
    log(`[kuramanime] Gagal warm-up: ${err.message} (lanjut saja)`)
  }
}

export function isEpisodeUrl(url) {
  return /\/episode\/[\d.]+(?:[/?#]|$)/i.test(url)
}

export function parseEpisodeBatchNav(html, currentUrl) {
  const $ = cheerio.load(html)
  const episodeNav = []
  $('#animeEpisodes a.ep-button').each((_, el) => {
    const href = $(el).attr('href')
    const label = $(el).text().replace(/\s+/g, ' ').trim()
    if (href) episodeNav.push({ label, url: href, active: $(el).hasClass('active-ep') })
  })
  const batchNav = []
  $('#animeEpisodesBatch a.ep-button').each((_, el) => {
    const href = $(el).attr('href')
    const label = $(el).text().replace(/\s+/g, ' ').trim()
    if (href) batchNav.push({ label, url: href, active: $(el).hasClass('active-ep') })
  })
  return {
    animeId: $('#animeId').attr('value') || null,
    postId: $('#postId').attr('value') || null,
    isEpisodePage: isEpisodeUrl(currentUrl),
    title: $('#episodeTitle').text().trim() || null,
    episodeNav,
    batchNav,
    checkEpisodeRoute: $('#checkEp').attr('value') || null,
    checkBatchRoute: $('#checkBatch').attr('value') || null
  }
}

export function parseStreamingSources($) {
  const sources = []
  $('#animeVideoPlayer video#player source').each((_, el) => {
    const src = $(el).attr('src')
    if (!src) return
    const size = $(el).attr('size')
    sources.push({ quality: size ? `${size}p` : $(el).attr('id') || '?', url: src })
  })
  return sources
}

// Struktur #animeDownloadLink: <h6>kualitas</h6> lalu <a> per host, berulang.
export function parseDownloadSection($) {
  const container = $('#animeDownloadLink')
  const groups = []
  let currentQuality = null
  container.contents().each((_, node) => {
    if (node.type !== 'tag') return
    if (node.name === 'h6') {
      currentQuality = $(node).text().replace(/\s+/g, ' ').trim()
      return
    }
    if (node.name === 'a') {
      const url = $(node).attr('href')
      if (!url) return
      const text = $(node).text().replace(/\s+/g, ' ').trim()
      let host = null
      try { host = new URL(url).hostname.replace(/^www\./, '') } catch { /* url relatif/aneh */ }
      groups.push({ quality: currentQuality, text: text || host || '?', host, url })
    }
  })
  return groups
}

export function isTokenErrorVisible($) {
  const el = $('#tokenErrorText')
  if (!el.length) return false
  const style = el.attr('style') || ''
  return !/display\s*:\s*none/i.test(style)
}

export function extractContainerError($, selector) {
  const el = $(selector)
  if (!el.length) return null
  const text = el.text().replace(/\s+/g, ' ').trim()
  const m = text.match(/Terjadi kesalahan saat [^,.]+/i)
  return m ? m[0].trim() : null
}

export async function fetchFullEpisodeOrBatchPage(session, url, _retry = 0) {
  const navHtml = await session.get(url)
  const nav = parseEpisodeBatchNav(navHtml, url)

  let streaming = []
  let downloads = []
  let streamingPending = false
  let contentError = null
  let contentWarning = null

  const checkRoute = nav.isEpisodePage ? nav.checkEpisodeRoute : nav.checkBatchRoute
  if (checkRoute) {
    try {
      await session.get(checkRoute, { ajax: true })
    } catch (checkErr) {
      contentWarning = `check-route gagal (lanjut coba ambil konten): ${checkErr.message}`
    }
  }

  try {
    const tokenValue = await session.fetchRotatingTokenValue(url)
    const contentHtml = await session.fetchPageContent(url, tokenValue)
    const $ = cheerio.load(contentHtml)

    if (isTokenErrorVisible($)) {
      throw new Error('Kuramanime membalas pesan error token (tokenErrorText) — kemungkinan KURAMA_MAGIC berubah.')
    }

    streaming = parseStreamingSources($)
    downloads = parseDownloadSection($)
    // Episode sangat baru: streaming-nya masih diproses situs (ada
    // countdown) — sumber streaming (pasangan id kDrive) belum ada,
    // tapi link unduhan biasanya sudah terbit lebih dulu.
    streamingPending = /countdownStream|Streaming sedang diproses/i.test(contentHtml)

    const videoError = !streaming.length ? extractContainerError($, '#animeVideoPlayer') : null
    const downloadError = !downloads.length ? extractContainerError($, '#animeDownloadLink') : null

    if (videoError || downloadError) {
      contentError = `Server Kuramanime membalas pesan gagal — Video: ${videoError || '(ok)'}; Download: ${downloadError || '(ok)'}`
    } else if (!streaming.length && !downloads.length) {
      contentError = 'Response 200 tapi link streaming & unduhan kosong.'
    }
  } catch (err) {
    contentError = err.message
  }

  const result = { ...nav, url, streaming, downloads, streamingPending, contentError, contentWarning }
  // Respons konten kadang kosong sesaat dari sisi Kuramanime (POST balas
  // 200 tapi tanpa link sama sekali) — satu kali ambil ulang biasanya
  // langsung beres; jangan menyerah di percobaan pertama untuk kasus itu.
  if (_retry < 1 && streaming.length === 0 && downloads.length === 0) {
    return fetchFullEpisodeOrBatchPage(session, url, _retry + 1)
  }
  return result
}
