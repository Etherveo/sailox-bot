// lib/downloader/downloadgram.js
//
// Resolver Instagram cadangan, port plugins/downloader-ig.js milik
// yue-bot: POST https://api.downloadgram.org/media -> HTML berisi tautan
// https://cdn.downloadgram.org/?token=<JWT> — payload JWT (segmen ke-2,
// base64url) membawa `force` + `url`/`filename` asli; hanya tautan
// ber-`force` yang dipakai, dideduplikasi berdasarkan url/filename asli.
//
// Dipakai sebagai FALLBACK engine instagram (engines/instagram.js):
// instatiktok tetap utama; downloadgram hanya dicoba bila instatiktok
// gagal. Riwayat: downloadgram pernah dibuang 2026-10-21 karena error di
// lapangan, lalu instatiktok yang error 2026-11-27 (laporan guardian ke
// founder untuk reel DbslNurTXOS) — jadi keduanya kini dirantai, bukan
// diganti. Verifikasi live 2026-11-27: downloadgram menjawab 200 dengan
// 3 tautan untuk reel yang sama.

const API_URL = 'https://api.downloadgram.org/media'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
const API_TIMEOUT_MS = 60 * 1000

// Ekstrak tautan media downloadgram dari HTML respons API, setia
// implementasi yue: regex cdn.downloadgram.org/?token=, decode payload
// JWT, lewati yang tanpa `force`, dedupe berdasarkan url/filename asli.
export function parseDownloadgramLinks(html) {
  const links = []
  const seen = new Set()
  for (const m of String(html ?? '').matchAll(/https:\/\/cdn\.downloadgram\.org\/\?token=[^"'\\\s<]+/g)) {
    const link = m[0]
    try {
      const token = new URL(link).searchParams.get('token')
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
      if (!payload?.force) continue
      const key = payload.url || payload.filename
      if (!key || seen.has(key)) continue
      seen.add(key)
      links.push(link)
    } catch { /* token bukan JWT valid — lewati */ }
  }
  return links
}

export async function resolveDownloadgram(url, { fetchFn = fetch } = {}) {
  const res = await fetchFn(API_URL, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'application/x-www-form-urlencoded',
      referer: 'https://downloadgram.org/',
      'User-Agent': UA,
    },
    body: new URLSearchParams({ url: String(url), v: '3', lang: 'en' }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`downloadgram merespons status ${res.status}.`)
  const html = await res.text()
  const links = parseDownloadgramLinks(html)
  if (!links.length) throw new Error('Tidak ada media yang ditemukan dari downloadgram.')
  return links
}
