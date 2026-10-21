// lib/kuramanime/resolve.js
//
// Resolver kDrive untuk sisi bot yang TER-WHITELIST (bot resolver dalam
// sistem relay antar-bot, atau mode direct): mengubah URL pembungkus
// kuramadrive.com/kdrive/<id> menjadi URL endpoint file bertanda tangan.
//
// Dua jalur (port dari proyek kuramanime standalone, kuramanime/kdrive.js):
//   1. Jalur episode (utama): halaman episode Kuramanime memuat pasangan
//      id <-> URL file di sumber streaming-nya — butuh episodeUrl asal
//      link. Ini satu-satunya jalur yang terbukti jalan dari jaringan
//      yang v1.kuramadrive.com-nya membalas 404 (kasus VM Muse).
//   2. Jalur landing: parse halaman v1 langsung — hanya jalan dari
//      jaringan yang memang ter-whitelist kuramadrive.

import { createSession, warmUp, fetchFullEpisodeOrBatchPage } from './core.js'
import { parseKdriveUrl } from '../downloader/engines/kdrive.js'

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

let sessionPromise = null
export function getKuramaSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const session = createSession()
      await warmUp(session)
      return session
    })()
  }
  return sessionPromise
}

export function fileNameFromUrl(fileUrl) {
  try {
    const base = new URL(String(fileUrl)).pathname.split('/').filter(Boolean).at(-1)
    return base ? decodeURIComponent(base) : ''
  } catch { return '' }
}

// Label kualitas memuat ukuran, mis. "MP4 360p (Hardsub) — (98.88 MB)".
// Satuan "MB" di situs itu sebenarnya MiB (terverifikasi byte-exact).
export function sizeFromQualityLabel(quality = '') {
  const m = String(quality).match(/\(\s*(\d+(?:[.,]\d+)?)\s*MB\s*\)/i)
  if (!m) return null
  return Math.round(parseFloat(m[1].replace(',', '.')) * 1024 * 1024)
}

export async function probeEndpointSize(fileUrl, fetchFn = fetch) {
  const res = await fetchFn(fileUrl, { headers: { Range: 'bytes=0-0' } })
  if (!res.ok && res.status !== 206) throw new Error(`Probe endpoint HTTP ${res.status}`)
  const cr = res.headers.get('content-range') || ''
  const total = cr.match(/\/(\d+)\s*$/)?.[1]
  await res.arrayBuffer().catch(() => {})
  return total ? Number(total) : null
}

export async function resolveViaEpisode(id, episodeUrl, { fetchEpisodePage, fetchFn = fetch } = {}) {
  const getPage = fetchEpisodePage || (async url => {
    const session = await getKuramaSession()
    return fetchFullEpisodeOrBatchPage(session, url)
  })
  const page = await getPage(episodeUrl)
  if (page.contentError) throw new Error(`Halaman episode gagal diambil: ${page.contentError}`)

  const entry = (page.downloads || []).find(d =>
    (d.host || '').includes('kuramadrive.com') && String(d.url).includes(`/${id}`))
  if (!entry) {
    throw new Error(`id kDrive ${id} tidak ditemukan di halaman episode itu — pastikan URL episode adalah asal link kDrive-nya.`)
  }
  const source = (page.streaming || []).find(s => String(s.url).includes(`/kdrive/${id}/`))
  if (!source) {
    if (page.streamingPending) {
      throw new Error(
        'Streaming episode ini masih DIPROSES Kuramanime (pasangan kDrive belum tersedia) — ' +
        'link unduhannya memang terbit lebih dulu. Coba lagi nanti, atau pilih provider lain (mis. Pixeldrain) yang tidak butuh pasangan streaming.'
      )
    }
    throw new Error(
      `id ${id} ada di daftar unduhan episode, tapi tidak ada sumber streaming pasangannya ` +
      '(kemungkinan kualitas MKV — pasangan id<->file hanya tersedia untuk MP4).'
    )
  }
  const fileUrl = source.url
  const exact = await probeEndpointSize(fileUrl, fetchFn).catch(() => null)
  return {
    fileUrl,
    fileName: fileNameFromUrl(fileUrl) || `kdrive-${id}`,
    size: exact ?? sizeFromQualityLabel(entry.quality),
    via: 'episode-page'
  }
}

export async function resolveViaLanding(wrapperUrl, { fetchFn = fetch } = {}) {
  const res = await fetchFn(wrapperUrl, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    redirect: 'follow'
  })
  if (!res.ok) throw new Error(`Halaman kuramadrive HTTP ${res.status} (di luar whitelist memang 404 untuk semua id)`)
  const html = await res.text()
  const fileUrl =
    html.match(/https?:\/\/[^\s"'<>]+\/kdrive\/[^\s"'<>]+/i)?.[0] ||
    html.match(/https?:\/\/[^\s"'<>]+\/kuramadrive\/[^\s"'<>]+/i)?.[0] ||
    html.match(/<a[^>]+href=["'](https?:\/\/[^"']+\.(?:mp4|mkv)(?:\?[^"']*)?)["']/i)?.[1] ||
    null
  if (!fileUrl) throw new Error('Tidak ada link file di halaman kuramadrive.')
  const clean = fileUrl.replace(/&amp;/g, '&')
  const { id } = parseKdriveUrl(wrapperUrl)
  const size = await probeEndpointSize(clean, fetchFn).catch(() => null)
  return { fileUrl: clean, fileName: fileNameFromUrl(clean) || `kdrive-${id}`, size, via: 'landing-page' }
}

/**
 * Resolusi utama: episodeUrl (bila ada) didahulukan; tanpa episodeUrl
 * dicoba jalur landing. Mengembalikan { fileUrl, fileName, size, via }.
 */
export async function resolveKdrive(wrapperUrl, { episodeUrl, fetchFn = fetch, fetchEpisodePage } = {}) {
  const { id } = parseKdriveUrl(wrapperUrl)
  if (episodeUrl) return resolveViaEpisode(id, episodeUrl, { fetchEpisodePage, fetchFn })
  return resolveViaLanding(wrapperUrl, { fetchFn })
}
