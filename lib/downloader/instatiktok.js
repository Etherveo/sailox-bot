// lib/downloader/instatiktok.js
//
// Resolver BERSAMA untuk Instagram, TikTok, dan Facebook — satu layanan
// (instatiktok.com) melayani ketiganya, persis seperti legacy
// plugins/downloader-download.js yang oleh pemiliknya dinyatakan sebagai
// versi yang benar-benar bekerja. (Engine per-platform sebelumnya —
// tikwm/savetik, fbdownloader, downloadgram — error di lapangan dan
// digantikan mekanisme ini pada 2026-10-21.)
//
// File ini modul bantuan di level lib (bukan engine): engine
// instagram.js, tiktok.js, dan facebook.js masing-masing tetap satu file
// per platform sesuai kontrak registry, dan hanya mengimpor
// resolveInstaTiktok() dari sini.
//
// Alur (setia legacy): POST https://instatiktok.com/api dengan form
// { url, platform, siteurl } -> JSON { status: 'success', html } -> dari
// HTML diambil semua <a class="btn" href="http..."> unik sesuai urutan.
// Pemilihan tautan mengikuti legacy: instagram = semua tautan (multi
// file), tiktok = tautan ber-`hdplay` (else pertama), facebook = terakhir.

const SITE_URL = 'https://instatiktok.com/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
// Layanan ini LAMBAT: terukur 22–66 detik per permintaan dari VM ini
// (sukses maupun gagal), jadi timeout harus lega — 30 detik membuat
// getInfo selalu gugur sebelum jawaban datang (itu sebab "masih error"
// di bot live pada 2026-10-21 walau mekanismenya benar). Legacy memakai
// axios tanpa timeout sama sekali.
// CATATAN: JANGAN menambahkan cookie sesi (PHPSESSID dari halaman depan)
// — teruji 2026-10-21 justru membuat respons jadi {"status":"failed"},
// sedangkan permintaan polos persis legacy berhasil.
const INFO_TIMEOUT_MS = 120 * 1000

/** Ekstrak href unik dari jangkar <a class="... btn ..." href="http...">, sesuai urutan dokumen. */
export function parseInstaTiktokLinks(html) {
  const links = []
  for (const m of String(html).matchAll(/<a[^>]*class\s*=\s*"[^"]*\bbtn\b[^"]*"[^>]*>/gi)) {
    const href = m[0].match(/href\s*=\s*"([^"]+)"/i)?.[1]
    if (href && /^https?:\/\//i.test(href) && !links.includes(href)) links.push(href)
  }
  return links
}

export async function resolveInstaTiktok(platform, url, { fetchFn = fetch } = {}) {
  const form = new URLSearchParams({ url, platform, siteurl: SITE_URL })
  const res = await fetchFn(`${SITE_URL}api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: SITE_URL,
      Referer: SITE_URL,
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: form,
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`instatiktok merespons status ${res.status}.`)
  const json = await res.json().catch(() => null)
  if (!json || json.status !== 'success' || !json.html) {
    throw new Error('Gagal memproses link lewat instatiktok (mungkin link tidak valid atau privat).')
  }
  const links = parseInstaTiktokLinks(json.html)
  if (!links.length) throw new Error('Tidak ada link unduhan yang ditemukan dari instatiktok.')
  return links
}
