// plugins/internet/nekopoi.js
//
// Port fitur legacy internet-nekopoi.js (.nekopoi search / .nekopoi
// detail, sumber nekopoi.care) ke Sailox — atas perintah Veo
// 2026-11-01, dengan dua penyesuaian dari speknya:
//   1. TANPA button. Legacy menampilkan hasil search sebagai tombol
//      single-select; di sini hasil search adalah daftar bernomor dan
//      pemilihannya lewat sesi handler.before di file ini (angka teks
//      biasa, tanpa reply — pola yang sama seperti sesi pilih GoFile
//      dan penawaran "y" di alur anime).
//   2. Premium only (handler.premium), seperti legacy (premium +
//      register; di Sailox cukup premium — pipeline menganggap
//      owner/mods sebagai premium).
//
// Seluruh logika fitur tinggal di plugin ini (aturan arsitektur §12):
// scraping memakai fetch bawaan + cheerio (axios legacy dibuang),
// error scraping dilog mentah ke terminal lalu dilaporkan ke chat.

import * as cheerio from 'cheerio'
import { reactTo, REACT } from '#lib/helpers/react.js'

export const NEKOPOI_BASE = 'https://nekopoi.care'
export const NEKOPOI_SESSION_TTL_MS = 5 * 60 * 1000
export const NEKOPOI_MAX_RESULTS = 10
const CAPTION_LIMIT = 1024

const HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'id-ID',
  'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
  referer: `${NEKOPOI_BASE}/`,
}

/* ─── Sesi hasil search ──────────────────────────────────────────────────── */

// Sesi hasil pencarian per chat+pengirim: angka balasan pengguna dipetakan
// ke link hasil di sesi ini. Kedaluwarsa malas seperti store sesi lain;
// sesi hanya bisa dibuka lewat perintah .nekopoi search (premium), jadi
// hook before tidak perlu gerbang peran sendiri — tanpa sesi, angka dan
// kata "batal" dilewati begitu saja.
export function createNekopoiSessionStore({ ttlMs = NEKOPOI_SESSION_TTL_MS, now = Date.now } = {}) {
  const map = new Map()
  const keyOf = (chat, sender) => `${chat}|${sender}`
  return {
    put(chat, sender, data) {
      const t = now()
      for (const [k, v] of map) if (v.expiresAt <= t) map.delete(k)
      map.set(keyOf(chat, sender), { ...data, expiresAt: t + ttlMs })
    },
    get(chat, sender) {
      const s = map.get(keyOf(chat, sender))
      if (!s) return null
      if (s.expiresAt <= now()) { map.delete(keyOf(chat, sender)); return null }
      return s
    },
    touch(chat, sender) {
      const s = map.get(keyOf(chat, sender))
      if (s && s.expiresAt > now()) s.expiresAt = now() + ttlMs
    },
    delete(chat, sender) { map.delete(keyOf(chat, sender)) },
  }
}

const sessions = createNekopoiSessionStore()

/* ─── Scraping ───────────────────────────────────────────────────────────── */

export function isNekopoiUrl(raw) {
  try {
    const u = new URL(String(raw ?? ''))
    return u.protocol === 'https:' && (u.hostname === 'nekopoi.care' || u.hostname.endsWith('.nekopoi.care'))
  } catch { return false }
}

async function fetchHtml(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: HEADERS, redirect: 'follow' })
  if (!res?.ok) throw new Error(`HTTP ${res?.status ?? '?'} dari ${new URL(url).hostname}`)
  return res.text()
}

export function parseSearchResults(html) {
  const $ = cheerio.load(html)
  const results = []
  $('.nk-search-results ul li').each((_, el) => {
    const title = $(el).find('h2').text().trim()
    const link = $(el).find('a').attr('href') || ''
    if (!title || !link) return
    const thumbnail = $(el).find('.nk-search-thumb').attr('style')?.match(/url\(['"]?(.*?)['"]?\)/)?.[1] || null
    results.push({
      title,
      link,
      thumbnail,
      genres: $(el).find('.nk-search-genres').text().trim(),
      description: $(el).find('.nk-search-desc').text().trim(),
    })
  })
  return results
}

export function parseDetail(html) {
  const $ = cheerio.load(html)
  const info = {}
  $('.konten p').each((_, el) => {
    const text = $(el).text().trim()
    const colonIdx = text.indexOf(':')
    if (colonIdx === -1) return
    const key = text.slice(0, colonIdx).trim().toLowerCase().replace(/\s+/g, '_')
    const val = text.slice(colonIdx + 1).trim()
    if (key && val) info[key] = val
  })
  const streams = []
  $('#nk-player .nk-player-frame').each((_, el) => {
    const src = $(el).find('iframe').attr('src') || ''
    if (src) streams.push({ id: $(el).attr('id') || '', src })
  })
  const downloads = []
  $('.nk-download-row').each((_, el) => {
    const quality = $(el).find('.nk-download-name').text().trim()
    const links = []
    $(el).find('.nk-download-links a').each((_, a) => {
      const url = $(a).attr('href') || ''
      if (url) links.push({ label: $(a).text().trim(), url })
    })
    if (quality && links.length) downloads.push({ quality, links })
  })
  const prevEl = $('.nk-episode-prev')
  const nextEl = $('.nk-episode-next')
  return {
    title: $('h1').first().text().trim(),
    thumbnail: $('meta[property="og:image"]').attr('content') || '',
    description: $('meta[property="og:description"]').attr('content') || '',
    info,
    streams,
    downloads,
    series: { title: $('.nk-player-series-title').text().trim(), url: $('.nk-player-series').attr('href') || '' },
    nav: {
      ...(prevEl.length ? { prev: { title: prevEl.find('span').text().trim(), url: prevEl.attr('href') || '' } } : {}),
      ...(nextEl.length ? { next: { title: nextEl.find('span').text().trim(), url: nextEl.attr('href') || '' } } : {}),
    },
  }
}

/* ─── Format tampilan ────────────────────────────────────────────────────── */

export function formatSearchText(keyword, results) {
  const lines = results.map((r, i) => {
    const genres = r.genres ? `\n   ${r.genres}` : ''
    return `${i + 1}. *${r.title}*${genres}`
  })
  return `🔍 *Hasil pencarian: "${keyword}"*\n\n${lines.join('\n')}\n\nBalas *angka* (teks biasa, tanpa reply) untuk lihat detailnya, atau *batal* untuk menutup sesi.`
}

export function formatDetailText(data) {
  let teks = `*${data.title || 'Tanpa judul'}*\n`
  if (data.info.genre) teks += `\n*Genre:* ${data.info.genre}`
  if (data.info.producers) teks += `\n*Producer:* ${data.info.producers}`
  if (data.info.duration) teks += `\n*Durasi:* ${data.info.duration}`
  if (data.info.size) teks += `\n*Size:* ${data.info.size}`
  if (data.info.anime) teks += `\n*Anime:* ${data.info.anime}`
  teks += `\n\n*Streaming:*`
  if (data.streams.length) for (const s of data.streams) teks += `\n  - ${s.id}: ${s.src}`
  else teks += '\n  Tidak ada link streaming.'
  teks += `\n\n*Download:*`
  if (data.downloads.length) {
    for (const dl of data.downloads) {
      teks += `\n  *${dl.quality}:*`
      for (const link of dl.links) teks += `\n    - ${link.label}: ${link.url}`
    }
  } else teks += '\n  Tidak ada link download.'
  if (data.series.url) teks += `\n\n*Series:* ${data.series.title}\n${data.series.url}`
  if (data.nav.prev) teks += `\n\n*Episode Sebelumnya:* ${data.nav.prev.title}\n${data.nav.prev.url}`
  if (data.nav.next) teks += `\n\n*Episode Selanjutnya:* ${data.nav.next.title}\n${data.nav.next.url}`
  return teks
}

/* ─── Kirim detail ───────────────────────────────────────────────────────── */

async function sendDetail(m, conn, data) {
  const teks = formatDetailText(data)
  if (data.thumbnail) {
    try {
      if (teks.length <= CAPTION_LIMIT) {
        await conn.sendMessage(m.chat, { image: { url: data.thumbnail }, caption: teks }, { quoted: m })
      } else {
        // Caption gambar WA terbatas ±1024 karakter; teks panjang dikirim
        // terpisah supaya tidak terpotong (pola yang sama seperti .bcc).
        await conn.sendMessage(m.chat, { image: { url: data.thumbnail } }, { quoted: m })
        await m.reply(teks)
      }
      return
    } catch (e) {
      // Thumbnail gagal diambil (hotlink/403) — detailnya tetap dikirim
      // sebagai teks, jangan gagalkan seluruh perintah.
      console.error('[nekopoi] kirim thumbnail gagal, lanjut teks saja:', e?.message || e)
    }
  }
  await m.reply(teks)
}

async function openDetail(m, ctx, url) {
  const conn = ctx?.conn ?? m.conn
  const fetchImpl = ctx?.nekopoiFetch ?? fetch
  await reactTo(m, REACT.processing).catch(() => {})
  try {
    const html = await fetchHtml(url, fetchImpl)
    const data = parseDetail(html)
    if (!data.title && !data.downloads.length && !data.streams.length) throw new Error('Halaman detail tidak memuat data yang dikenali (struktur situs berubah?).')
    await sendDetail(m, conn, data)
    await reactTo(m, REACT.done).catch(() => {})
  } catch (e) {
    console.error('[nekopoi] ambil detail gagal:', e)
    await reactTo(m, REACT.error).catch(() => {})
    throw `❌ Gagal mengambil detail:\n${e.message || e}`
  }
}

/* ─── Handler ────────────────────────────────────────────────────────────── */

let handler = async (m, ctx) => {
  const { text, usedPrefix, command } = ctx
  const parts = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  const sub = (parts[0] ?? '').toLowerCase()
  const fetchImpl = ctx?.nekopoiFetch ?? fetch

  if (sub === 'search') {
    const keyword = parts.slice(1).join(' ')
    if (!keyword) throw `Masukkan judulnya!\nContoh: ${usedPrefix + command} search <judul>`
    await reactTo(m, REACT.processing).catch(() => {})
    let results
    try {
      const html = await fetchHtml(`${NEKOPOI_BASE}/search/${encodeURIComponent(keyword)}`, fetchImpl)
      results = parseSearchResults(html).slice(0, NEKOPOI_MAX_RESULTS)
    } catch (e) {
      console.error('[nekopoi] pencarian gagal:', e)
      await reactTo(m, REACT.error).catch(() => {})
      throw `❌ Pencarian gagal:\n${e.message || e}`
    }
    if (!results.length) {
      await reactTo(m, REACT.error).catch(() => {})
      return m.reply(`🔍 Tidak ada hasil untuk "${keyword}".`)
    }
    const store = ctx?.nekopoiSessions ?? sessions
    store.put(m.chat, m.sender, { keyword, items: results })
    await reactTo(m, REACT.done).catch(() => {})
    return m.reply(formatSearchText(keyword, results))
  }

  if (sub === 'detail') {
    const url = parts[1] ?? ''
    if (!isNekopoiUrl(url)) throw `Link tidak valid — harus link nekopoi.care.\nContoh: ${usedPrefix + command} detail https://nekopoi.care/...`
    return openDetail(m, ctx, url)
  }

  throw `Perintah tidak dikenali. Gunakan:\n${usedPrefix + command} search <judul>\n${usedPrefix + command} detail <url nekopoi.care>`
}

handler.help = ['nekopoi search <judul>', 'nekopoi detail <url>']
handler.tags = ['internet']
handler.command = /^nekopoi$/i
handler.premium = true

// Sesi hasil search: angka teks biasa dari pembuka sesi membuka detail
// pilihan itu (sesi tetap buka untuk pilihan lain sampai kedaluwarsa),
// "batal" menutup sesi. Tanpa sesi aktif, pesan dilewati (return false)
// supaya obrolan dan sesi fitur lain tidak terganggu.
handler.before = async (m, ctx) => {
  if (m.fromMe) return false
  const text = (m.text ?? '').trim()
  if (!text) return false
  const lower = text.toLowerCase()
  const isPick = /^\d+$/.test(text) || lower === 'batal'
  if (!isPick) return false
  const store = ctx?.nekopoiSessions ?? sessions
  const session = store.get(m.chat, m.sender)
  if (!session) return false

  if (lower === 'batal') {
    store.delete(m.chat, m.sender)
    await m.reply('Sesi pencarian ditutup.')
    return true
  }

  const n = Number(text)
  if (n < 1 || n > session.items.length) {
    await m.reply(`Nomor di luar daftar (1–${session.items.length}). Ketik *batal* buat tutup sesi.`)
    return true
  }
  const item = session.items[n - 1]
  store.touch(m.chat, m.sender)
  await openDetail(m, ctx, item.link)
  return true
}

export default handler
