// lib/kuramanime/catalog.js
//
// Katalog Kuramanime untuk bot: ongoing (update terbaru), pencarian,
// dan detail anime (daftar episode/batch). Port dari proyek kuramanime
// standalone (kurama-ongoing.js + kurama.js) di atas sesi bersama di
// core.js — versi CLI interaktifnya dibuang, parser & pengambilnya
// dipertahankan apa adanya sebisa mungkin.

import * as cheerio from 'cheerio'
import { BASE_URL } from './core.js'
import { getKuramaSession } from './resolve.js'

const ONGOING_URL = `${BASE_URL}/quick/ongoing`

/* ─── Ongoing ────────────────────────────────────────────────────────────── */

export function buildLatestUrl(item) {
  const post = item.posts?.[0]
  if (!post) return `${BASE_URL}/anime/${item.id}/${item.slug}`
  if (post.type === 'Batch' && post.episode_batch) {
    return `${BASE_URL}/anime/${item.id}/${item.slug}/batch/${post.episode_batch}`
  }
  const epNum = post.episode_decimal ?? post.episode
  return `${BASE_URL}/anime/${item.id}/${item.slug}/episode/${epNum}`
}

export function formatOngoingLabel(item) {
  const post = item.posts?.[0]
  const type = post?.type || '?'
  const epNum = post?.episode_decimal ?? post?.episode ?? item.latest_episode ?? '?'
  const epStr = type === 'Batch' && post?.episode_batch ? `Batch ${post.episode_batch}` : `Ep ${epNum}`
  const status = item.is_new_release ? ' [BARU]' : item.is_new_updated ? ' [UPDATE]' : ''
  const quality = item.quality ? ` (${item.quality})` : ''
  return `${item.title}${quality} — ${epStr}${status}`
}

export function parseOngoingJson(raw) {
  let data = raw
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw) } catch { return null }
  }
  if (!data || typeof data !== 'object') return null
  const list = data.ongoingAnimes?.data ?? data.animes?.data ?? (Array.isArray(data.data) ? data.data : null)
  if (!list || !Array.isArray(list)) return null
  const pagination = data.ongoingAnimes ?? data.animes ?? data
  return {
    items: list,
    pagination: {
      currentPage: pagination.current_page ?? 1,
      totalPages: pagination.last_page ?? 1,
      totalResults: pagination.total ?? list.length,
      hasNext: pagination.next_page_url != null,
      hasPrev: pagination.prev_page_url != null
    }
  }
}

export function parseOngoingHtml(html) {
  const $ = cheerio.load(html)
  const items = []
  const selectors = ['.product__item', '.filter__gallery > a', '.anime__sidebar__comment__item']
  let found = false
  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const a = $(el).is('a') ? $(el) : $(el).find('a').first()
      const href = a.attr('href') || ''
      if (!href.includes('/anime/')) return
      const title = $(el).find('h5, .sidebar-title-h5, .title').first().text().trim() || a.attr('title') || a.text().trim()
      if (!title) return
      const epText = $(el).find('.ep, .episode, .badge').first().text().trim()
      const m = href.match(/\/anime\/(\d+)\/([^/?#]+)/)
      if (!m) return
      found = true
      items.push({ id: m[1], slug: m[2], title, quality: null, posts: [], latest_episode: epText || null, _fallbackUrl: href })
    })
    if (found) break
  }
  if (!found) {
    $('a[href*=\'/episode/\']').each((_, el) => {
      const href = $(el).attr('href') || ''
      const m = href.match(/\/anime\/(\d+)\/([^/?#]+)\/episode\/([\d.]+)/)
      if (!m) return
      const title = $(el).text().trim() || $(el).attr('title') || `Anime ${m[1]}`
      items.push({ id: m[1], slug: m[2], title, quality: null, posts: [{ type: 'Episode', episode: parseFloat(m[3]), episode_batch: null }], latest_episode: parseFloat(m[3]) })
    })
  }
  if (!items.length) return { items: [], pagination: null }
  const seen = new Set()
  const unique = items.filter(it => (seen.has(it.id) ? false : (seen.add(it.id), true)))
  return { items: unique, pagination: null }
}

export async function fetchOngoingPage({ page = 1, orderBy = 'updated', session } = {}) {
  const s = session || (await getKuramaSession())
  const params = new URLSearchParams({ order_by: orderBy, page: String(page), need_json: 'true' })
  const raw = await s.get(`${ONGOING_URL}?${params.toString()}`, { ajax: true })
  const jsonResult = parseOngoingJson(raw)
  if (jsonResult) return { ...jsonResult, source: 'json' }
  const htmlResult = parseOngoingHtml(typeof raw === 'string' ? raw : '')
  if (!htmlResult.items.length) throw new Error('Tidak ada item ditemukan di halaman ongoing (JSON & fallback HTML gagal).')
  return { ...htmlResult, source: 'html' }
}

/* ─── Pencarian ──────────────────────────────────────────────────────────── */

export function buildSearchUrl({ keyword, orderBy = 'ascending', page = 1 }) {
  const p = new URLSearchParams({ search: keyword, order_by: orderBy, page: String(page), need_json: 'true' })
  return `/anime?${p.toString()}`
}

export function extractAnimeIdSlug(url) {
  const m = String(url).match(/\/anime\/(\d+)\/([^/?#]+)/)
  return m ? { id: m[1], slug: m[2] } : null
}

export function parseSearchPage(raw) {
  let data = raw
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw) } catch { /* lanjut fallback HTML */ }
  }
  if (data && typeof data === 'object' && data.animes && Array.isArray(data.animes.data)) {
    const p = data.animes
    return {
      items: p.data.map(item => ({
        id: item.id,
        slug: item.slug,
        url: `${BASE_URL}/anime/${item.id}/${item.slug}`,
        title: item.title,
        score: item.score ?? null,
        quality: item.quality || null
      })),
      pagination: {
        currentPage: p.current_page,
        totalPages: p.last_page,
        totalResults: p.total,
        hasNext: p.next_page_url != null,
        hasPrev: p.prev_page_url != null
      }
    }
  }
  const $ = cheerio.load(typeof raw === 'string' ? raw : '')
  const items = []
  $('#animeList > .filter__gallery > a').each((_, el) => {
    const href = $(el).attr('href') || ''
    const box = $(el).find('.product__sidebar__view__item')
    const title = box.find('h5.sidebar-title-h5').text().trim()
    const score = box.find('.ep span[class^=\'actual-anime-\']').text().trim() || null
    const quality = box.find('.view').first().text().trim() || null
    const info = extractAnimeIdSlug(href)
    if (!info || !title) return
    items.push({ id: info.id, slug: info.slug, url: href, title, score, quality })
  })
  let maxPage = 1
  $('a[aria-label^=\'Go to page\']').each((_, el) => {
    const n = parseInt($(el).text().trim(), 10)
    if (!Number.isNaN(n) && n > maxPage) maxPage = n
  })
  const currentPage = parseInt($("span[aria-current='page'] span").first().text().trim(), 10) || 1
  return {
    items,
    pagination: { currentPage, totalPages: Math.max(maxPage, currentPage), totalResults: null, hasNext: currentPage < maxPage, hasPrev: currentPage > 1 }
  }
}

export async function searchAnime(keyword, { page = 1, session } = {}) {
  const s = session || (await getKuramaSession())
  const raw = await s.get(buildSearchUrl({ keyword, page }), { ajax: true })
  return parseSearchPage(raw)
}

/* ─── Detail anime ───────────────────────────────────────────────────────── */

export function decodeEntities(str = '') {
  return str.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

export function parseNavLinksFromFragment(fragmentHtml) {
  const $$ = cheerio.load(fragmentHtml)
  const list = []
  $$('a').each((_, el) => {
    const href = $$(el).attr('href')
    const label = $$(el).text().replace(/\s+/g, ' ').trim()
    if (href && label) list.push({ label, url: href.startsWith('http') ? href : `${BASE_URL}${href}` })
  })
  return list
}

export function parseDetailPage(html) {
  const $ = cheerio.load(html)
  const titleBlock = $('.anime__details__title').first()
  const title = titleBlock.find('h3').text().trim() || $('h1, h2').first().text().trim()
  const altTitle = titleBlock.children('span').first().text().trim() || null
  const synopsisEl = $('#synopsisField')
  let synopsis = null
  if (synopsisEl.length) {
    const h = $.html(synopsisEl.get(0)).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    synopsis = decodeEntities(h).trim()
  }
  const info = {}
  $('.anime__details__widget li').each((_, li) => {
    const label = $(li).find('div.col-3 span').first().text().replace(':', '').trim()
    if (!label) return
    const valueWrap = $(li).find('div.col-9').first()
    const links = valueWrap.find('a')
    const value = links.length ? links.map((__, a) => $(a).text().trim()).get().join(' ') : valueWrap.text().trim()
    if (value) info[label] = value
  })
  const episodeAttr = $('#episodeLists').attr('data-content')
  const episodeList = episodeAttr ? parseNavLinksFromFragment(episodeAttr) : []
  const batchAttr = $('#episodeBatchLists').attr('data-content')
  const batchList = batchAttr ? parseNavLinksFromFragment(batchAttr) : []
  return {
    animeId: $('#animeId').attr('value') || null,
    title,
    altTitle,
    synopsis,
    info,
    episodeList,
    batchList
  }
}

export async function fetchAnimeDetail(url, { session } = {}) {
  const s = session || (await getKuramaSession())
  const html = await s.get(url)
  return { ...parseDetailPage(html), url }
}
