// lib/downloader/engines/kdrive.js
//
// Engine untuk kDrive (Kuramadrive, provider unduhan Kuramanime).
// URL pembungkus: https://v1.kuramadrive.com/kdrive/<id> (atau /kturbo/<id>).
// File aslinya disajikan pool endpoint bertanda tangan, pola:
//   https://<host>.my.id/kdrive/<id>/<namafile>?lud=..&pid=..&sid=..&cce=1&upx=n
//   https://<hash>.r2.cloudflarestorage.com/kuramadrive/ANIME/...
// (host teramati: anisphia, asuna, iino, chisato, komari, amiya — semuanya
// .my.id; host bisa berganti antar sesi, jadi TIDAK di-hardcode di luar
// pola domainnya. Pemetaan lengkap: proyek kuramanime, endpoint-samples.json.)
//
// DUA MODE (diatur founder lewat .config set kdriveMode direct|stranger,
// tersimpan sebagai global.kdriveMode oleh lib/helpers/configStore.js):
//
//  - direct (bawaan): bot me-request halaman v1.kuramadrive.com sendiri.
//    Hanya jalan dari jaringan yang masuk whitelist kuramadrive — dari
//    jaringan di luar whitelist halaman itu membalas 404 untuk semua id
//    (terverifikasi 2026-10-21 dari VM Muse: script + browser asli).
//
//  - stranger: bot berada di server "asing" (di luar whitelist). Bot TIDAK
//    me-request kuramadrive sama sekali. Resolusi URL pembungkus -> URL
//    endpoint dilakukan pihak yang ter-whitelist (bot utama / relay),
//    lalu .unduh dipanggil dengan URL ENDPOINT LANGSUNGnya — engine ini
//    menerimanya (lihat match()) dan tinggal mengunduh file-nya. Itulah
//    pemisahannya: resolusi itu ringan (HTML/JSON), berkasnya yang berat
//    tidak pernah lewat pihak peresolusi.
//
// Resolusi lewat halaman episode Kuramanime (pasangan id <-> sumber
// streaming) SENGAJA tidak ada di sini: .unduh tidak punya konteks
// episode. Implementasi lengkapnya hidup di proyek kuramanime
// (kuramanime/kdrive.js) dan bisa dipindah ke relay peresolusi nanti.
//
// Kontrak engine: ekspor `id`, `match(url)`, `getInfo(url)`,
// `download(url, info, { destDir, baseName, maxBytes })`.

import path from 'node:path'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'

export const id = 'kdrive'

const INFO_TIMEOUT_MS = 30 * 1000
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export function currentMode() {
  return globalThis.kdriveMode === 'stranger' ? 'stranger' : 'direct'
}

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase() } catch { return '' }
}

function isWrapperHost(host) {
  return host === 'kuramadrive.com' || host.endsWith('.kuramadrive.com')
}

function isEndpointHost(url) {
  const host = hostOf(url)
  if (!host) return false
  let pathname = ''
  try { pathname = new URL(String(url)).pathname } catch { return false }
  if (host.endsWith('.my.id') || host === 'my.id') return pathname.startsWith('/kdrive/')
  if (host.endsWith('.r2.cloudflarestorage.com')) return pathname.includes('/kuramadrive/')
  return false
}

export function match(url = '') {
  const host = hostOf(url)
  if (!host) return false
  if (isWrapperHost(host)) {
    try { return /\/(kdrive|kturbo)\/[^/?#]+/i.test(new URL(String(url)).pathname) } catch { return false }
  }
  return isEndpointHost(url)
}

/** Urai URL pembungkus kDrive → { variant: 'kdrive'|'kturbo', id }. */
export function parseKdriveUrl(url = '') {
  const m = String(url).trim().match(/kuramadrive\.com\/(kdrive|kturbo)\/([^/?#]+)/i)
  if (!m) throw new Error('URL tidak valid untuk kDrive (bentuk: .../kdrive/<id> atau .../kturbo/<id>).')
  return { variant: m[1].toLowerCase(), id: m[2] }
}

function fileNameFromUrl(fileUrl) {
  try {
    const base = new URL(String(fileUrl)).pathname.split('/').filter(Boolean).at(-1)
    return base ? decodeURIComponent(base) : ''
  } catch { return '' }
}

// Probe 1 byte: ukuran pasti dari Content-Range + bukti link hidup.
async function probeEndpoint(fetchFn, fileUrl) {
  const res = await fetchFn(fileUrl, {
    headers: { Range: 'bytes=0-0' },
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS)
  })
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} dari ${hostOf(fileUrl)}`)
  const cr = res.headers.get('content-range') || ''
  const total = cr.match(/\/(\d+)\s*$/)?.[1]
  const mimetype = res.headers.get('content-type') || ''
  await res.arrayBuffer().catch(() => {})
  return { size: total ? Number(total) : null, mimetype }
}

function extractFileLink(html) {
  return (
    html.match(/https?:\/\/[^\s"'<>]+\/kdrive\/[^\s"'<>]+/i)?.[0] ||
    html.match(/https?:\/\/[^\s"'<>]+\/kuramadrive\/[^\s"'<>]+/i)?.[0] ||
    html.match(/<a[^>]+href=["'](https?:\/\/[^"']+\.(?:mp4|mkv)(?:\?[^"']*)?)["']/i)?.[1] ||
    null
  )?.replace(/&amp;/g, '&') || null
}

/**
 * Ambil metadata TANPA mengunduh body file.
 * - URL endpoint langsung (pool .my.id / R2): probe Range -> { fileName, size, mimetype, fileUrl, direct: true }
 * - URL pembungkus + mode direct: resolusi dari halaman v1 -> info file endpoint-nya.
 * - URL pembungkus + mode stranger: DITOLAK dengan penjelasan (bot tidak
 *   boleh me-request kuramadrive; minta URL endpoint hasil resolusi).
 */
export async function getInfo(url, { fetchFn = fetch } = {}) {
  const str = String(url).trim()

  if (isEndpointHost(str)) {
    const probe = await probeEndpoint(fetchFn, str)
    return {
      fileName: fileNameFromUrl(str) || `kdrive-${Date.now()}`,
      size: probe.size,
      mimetype: probe.mimetype,
      fileUrl: str,
      direct: true
    }
  }

  const { id: fileId } = parseKdriveUrl(str)

  if (currentMode() === 'stranger') {
    throw new Error(
      'Mode stranger aktif: bot ini tidak me-request kuramadrive langsung. ' +
      'Bila kdrivePeer terpasang, .unduh me-relay link pembungkus ke bot pasangan untuk ' +
      'diresolusikan; tanpa pasangan, panggil .unduh dengan URL endpoint langsungnya ' +
      '(host pool .my.id / R2). Matikan lewat .config set kdriveMode direct bila server ' +
      'ini sudah ter-whitelist.'
    )
  }

  let res
  try {
    res = await fetchFn(str, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS)
    })
  } catch (e) {
    throw new Error(`Gagal menghubungi kuramadrive: ${e.message}`)
  }
  if (!res.ok) {
    throw new Error(
      `Halaman kuramadrive membalas HTTP ${res.status} untuk id ${fileId} — dari jaringan di luar ` +
      'whitelist kuramadrive halaman ini memang 404 untuk semua id, jadi link pembungkus saja ' +
      'tidak cukup dari jaringan ini. Sertakan URL EPISODE asal link-nya sebagai konteks ' +
      'resolusi: .unduh <link kdrive> | <link episode kuramanime>. Atau, bila server bot ini di ' +
      'luar whitelist, aktifkan mode stranger (.config set kdriveMode stranger).'
    )
  }
  const html = await res.text()
  const fileUrl = extractFileLink(html)
  if (!fileUrl) {
    throw new Error('Tidak ada link file di halaman kuramadrive — format halamannya mungkin berubah.')
  }
  const probe = await probeEndpoint(fetchFn, fileUrl).catch(() => ({ size: null, mimetype: '' }))
  return {
    fileName: fileNameFromUrl(fileUrl) || `kdrive-${fileId}`,
    size: probe.size,
    mimetype: probe.mimetype,
    fileUrl
  }
}

/**
 * Unduh file ke disk (streaming, tidak dibuffer ke RAM) — pola yang sama
 * seperti engine pixeldrain: nama final dari mimetype header respons.
 */
export async function download(url, info, { destDir, baseName, maxBytes, fetchFn = fetch } = {}) {
  if (!info?.fileUrl) throw new Error('Info kDrive tidak punya fileUrl — resolusi dulu lewat getInfo.')
  const response = await fetchFn(info.fileUrl)
  if (!response.ok) {
    throw new Error(
      `Gagal mengunduh file (${response.status})` +
      (info.direct ? ' — tanda tangan URL endpoint mungkin sudah kedaluwarsa, resolusikan ulang.' : '')
    )
  }
  const mimetype = response.headers.get('content-type') || info.mimetype || 'application/octet-stream'
  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)
  const bytes = await streamToFile(response.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}
