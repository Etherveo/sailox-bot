// lib/downloader/engines/facebook.js
//
// Engine murni untuk Facebook. Mekanisme saat ini (2026-11-07): port
// scraper/facebook.js milik yue-bot (fbdownloader.to ajaxSearch) —
// versi yang pemilik putuskan setelah jalur API ponta terbukti
// mewajibkan API key berbayar (401 "API key is required"; plugin FB
// yue sendiri pun tak membawa key). Riwayat resolver: fbdownloader.to
// (dibuang 2026-10-21 karena implementasi lama error) -> instatiktok
// -> ponta (butuh key) -> fbdownloader.to lagi dengan implementasi
// yue (2026-11-07). Yang membedakan dari implementasi lama yang
// dibuang: pemilihan kualitas setia scraper yue — baris 720p pertama,
// kalau tidak ada baris pertama — dan parsing tabel hasil ajaxSearch
// persis selektor scraper.
//
// Catatan pemilik mencoba menyimpan scraper ini mentah-mentah dari WA
// (2026-11-07 21:05): gagal hot-reload karena `import cheerio from
// 'cheerio'` — cheerio 1.x ESM tidak punya ekspor default; bentuk
// yang benar `import { load } from 'cheerio'` (sama seperti engine
// tiktok). File plugin nyasar itu sudah dibersihkan; mekanismenya
// hidup di sini sebagai engine, bukan plugin perintah (aturan §12).

import path from 'node:path'
import { load } from 'cheerio'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'

export const id = 'facebook'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const API_URL = 'https://fbdownloader.to/api/ajaxSearch'
// Token situs fbdownloader.to sebagaimana tertanam di scraper yue
// (bukan kredensial pemilik).
const K_EXP = '1774563978'
const K_TOKEN = 'bf5f184186c1e636ba3ffbd80b8498925af63e7c599a3f740781f38a2813194d'
const API_TIMEOUT_MS = 60 * 1000
const INFO_TIMEOUT_MS = 30 * 1000

export function match(url = '') {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    return host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.watch'
  } catch { return false }
}

// Ekstrak baris kualitas dari HTML ajaxSearch: kualitas dari
// .video-quality, tautan dari a.download-link-fb (cadangan:
// button[data-videourl]). Diekspor untuk tes.
export function parseFbDownloaderRows(html) {
  const $ = load(String(html ?? ''))
  const results = []
  $('.table tbody tr').each((_, el) => {
    const quality = $(el).find('.video-quality').text().trim()
    const link = $(el).find('a.download-link-fb').attr('href') || $(el).find('button').attr('data-videourl')
    if (quality && link) results.push({ quality, url: link })
  })
  return results
}

export async function resolveFbDownloader(url, { fetchFn = fetch } = {}) {
  const res = await fetchFn(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      referer: 'https://fbdownloader.to/id',
      'user-agent': UA,
    },
    body: new URLSearchParams({ k_exp: K_EXP, k_token: K_TOKEN, p: 'home', q: String(url), lang: 'id', v: 'v2', w: '' }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`fbdownloader.to menjawab HTTP ${res.status}.`)
  const data = await res.json().catch(() => null)
  if (data?.status !== 'ok') throw new Error('Gagal mengambil data dari fbdownloader.to')
  const results = parseFbDownloaderRows(data.data)
  if (!results.length) throw new Error('Tidak ada video yang ditemukan dari fbdownloader.to')
  return results
}

export async function getInfo(url, { fetchFn = fetch } = {}) {
  const results = await resolveFbDownloader(url, { fetchFn })
  // Setia scraper yue: 720p pertama; kalau tidak ada, baris pertama.
  const chosen = results.find(r => r.quality.toLowerCase().includes('720p')) ?? results[0]
  const videoId = String(url).match(/(\d{5,})/)?.[1] ?? 'video'
  let size = null
  try {
    const head = await fetchFn(chosen.url, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) })
    if (head.ok) size = parseInt(head.headers.get('content-length') || '0', 10) || null
  } catch { /* HEAD ditolak — lanjut tanpa ukuran pasti */ }
  return { fileName: `facebook-${videoId}.mp4`, size, mimetype: 'video/mp4', downloadUrl: chosen.url }
}

export async function download(url, info, { destDir, baseName, maxBytes, fetchFn = fetch } = {}) {
  if (!info?.downloadUrl) throw new Error('Info Facebook tidak membawa link unduhan.')
  const response = await fetchFn(info.downloadUrl, { headers: { 'User-Agent': UA } })
  if (!response.ok) throw new Error(`Gagal mengunduh media (${response.status})`)
  const mimetype = response.headers.get('content-type') || info.mimetype || 'video/mp4'
  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)
  const bytes = await streamToFile(response.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}
