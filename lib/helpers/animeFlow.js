// lib/helpers/animeFlow.js
//
// Alur pilih-bertingkat untuk fitur anime (plugins/anime/): pengguna
// cukup menempel link episode ATAU mulai dari .ongoing/.carianime, lalu
// melangkah dengan .pilih <nomor> — tanpa menyalin dua link seperti
// alur .unduh kDrive manual.
//
// Tahapan (state per chat+pengirim, TTL 10 menit, maks 200 entri):
//   ongoing   -> item dipilih = episode/batch terbaru judul itu
//   search    -> item dipilih = detail anime (daftar episode+batch)
//   episodes  -> item dipilih = satu episode/batch
//   providers -> item dipilih = unduh (engine) / tampilkan link mentah
//
// Unduhan dieksekusi plugin lewat runDownloadJob (lib/downloader/runJob.js)
// supaya perilaku info-dulu, kirim WA, dan kebijakan disk-nya sama persis
// dengan jalur downloader lain. Khusus kDrive: resolusi ke URL endpoint
// dilakukan di sini (konteks episode memang sedang dipegang alur ini).

import { fetchFullEpisodeOrBatchPage } from '../kuramanime/core.js'
import { getKuramaSession, resolveKdrive } from '../kuramanime/resolve.js'
import { buildLatestUrl, formatOngoingLabel, fetchAnimeDetail } from '../kuramanime/catalog.js'
import { detectProvider as registryDetect, ensureEngines } from '../downloader/index.js'

export const FLOW_TTL_MS = 10 * 60 * 1000
const FLOW_MAX = 200
const flows = new Map()

export function flowKey(m) { return `${m.chat}|${m.sender}` }

export function setFlow(key, data) {
  const now = Date.now()
  for (const [k, v] of flows) if (v.expiresAt <= now) flows.delete(k)
  while (flows.size >= FLOW_MAX) flows.delete(flows.keys().next().value)
  flows.set(key, { ...data, expiresAt: now + FLOW_TTL_MS })
}

export function getFlow(key) {
  const f = flows.get(key)
  if (!f) return null
  if (f.expiresAt <= Date.now()) { flows.delete(key); return null }
  return f
}

export function clearFlow(key) { flows.delete(key) }

/* ─── Format tampilan ────────────────────────────────────────────────────── */

const pickHint = 'Balas *.pilih <nomor>* untuk memilih.'

export function formatOngoingView(result, page) {
  const lines = result.items.map((it, i) => `${i + 1}. ${formatOngoingLabel(it)}`)
  const total = result.pagination?.totalResults ? `\nTotal: ${result.pagination.totalResults} judul` : ''
  const pages = result.pagination ? ` (hal. ${result.pagination.currentPage}/${result.pagination.totalPages})` : ''
  return `📺 *Anime Update Terbaru*${pages}${total}\n\n${lines.join('\n')}\n\n${pickHint}\nHalaman lain: *.ongoing <nomor halaman>*`
}

export function formatSearchView(keyword, result) {
  if (!result.items.length) return `🔍 Tidak ada hasil untuk "${keyword}". Coba kata kunci lain.`
  const lines = result.items.map((it, i) => {
    const score = it.score ? ` ⭐${it.score}` : ''
    const quality = it.quality ? ` [${it.quality}]` : ''
    return `${i + 1}. ${it.title}${score}${quality}`
  })
  const pages = result.pagination ? `\nHalaman ${result.pagination.currentPage}/${result.pagination.totalPages} — *.carianime ${keyword} <hal>* untuk halaman lain` : ''
  return `🔍 *Hasil pencarian: "${keyword}"*\n\n${lines.join('\n')}${pages}\n\n${pickHint}`
}

export function formatEpisodesView(detail) {
  const items = detail._combined || []
  const lines = items.map((it, i) => `${i + 1}. ${it.label}`)
  const head = `🎬 *${detail.title || 'Anime'}*`
  return `${head}\nEpisode/batch tersedia: ${items.length}\n\n${lines.join('\n')}\n\n${pickHint}`
}

// Entri kDrive berkualitas MKV tidak akan pernah bisa diresolusi lewat
// jalur episode (sumber streaming hanya ada untuk MP4) — perlakukan
// sebagai link saja sejak tampilan, jangan janjikan ✅.
export function isDownloadableEntry(entry, engineId) {
  if (!engineId) return false
  if (engineId === 'kdrive' && /mkv/i.test(entry.quality || '')) return false
  return true
}

export function formatProvidersView(page, detect = registryDetect) {
  const lines = []
  let lastQuality = null
  let n = 0
  for (const d of page.downloads) {
    if (d.quality !== lastQuality) { lines.push(`\n*${d.quality || 'Kualitas ?'}*`); lastQuality = d.quality }
    n++
    const engineId = safeDetect(detect, d.url)
    const mark = isDownloadableEntry(d, engineId) ? '✅' : '🔗'
    lines.push(`${n}. ${d.text || d.host || '?'} ${mark}`)
  }
  return `🎬 *${page.title || 'Episode'}*\nPilih provider unduhan:${lines.join('\n')}\n\n✅ = bisa diunduh bot, 🔗 = link ditampilkan saja\n${pickHint}`
}

function safeDetect(detect, url) {
  try { return detect(url) } catch { return null }
}

/* ─── Langkah alur ───────────────────────────────────────────────────────── */

async function defaultFetchEpisodePage(url) {
  const session = await getKuramaSession()
  return fetchFullEpisodeOrBatchPage(session, url)
}

async function openEpisode(url, deps = {}) {
  const page = await (deps.fetchEpisodePage || defaultFetchEpisodePage)(url)
  if (page.contentError) throw new Error(page.contentError)
  if (!page.downloads?.length) return { type: 'view', text: `🎬 *${page.title || 'Episode'}*\n\nLink unduhan kosong di halaman ini.` }
  return {
    type: 'view',
    text: formatProvidersView(page, deps.detectProvider || registryDetect),
    flow: { stage: 'providers', title: page.title, episodeUrl: url, items: page.downloads }
  }
}

/**
 * Majukan alur satu langkah berdasarkan nomor pilihan (1-based).
 * Mengembalikan { type: 'view', text, flow? } | { type: 'download', provider, url, fileName? } | { type: 'link', url, text }
 * deps dapat diinjeksi untuk tes.
 */
export async function advanceFlow(flow, index, deps = {}) {
  const item = flow.items?.[index - 1]
  if (!item) throw new Error(`Nomor tidak valid. Pilihan tersedia 1–${flow.items?.length || 0}.`)

  switch (flow.stage) {
    case 'ongoing': {
      const target = item._fallbackUrl && /\/(episode|batch)\//.test(item._fallbackUrl)
        ? item._fallbackUrl
        : buildLatestUrl(item)
      return openEpisode(target, deps)
    }
    case 'search': {
      // Default ke implementasi asli catalog — pola yang sama seperti
      // deps lain (fetchEpisodePage/detectProvider/resolveKdrive).
      // Dulu di sini TIDAK ada default dan plugin .pilih memanggil
      // advanceFlow tanpa deps, jadi tahap ini selalu melempar
      // 'fetchAnimeDetail tidak tersedia' di produksi (tes unit lolos
      // karena selalu menyuntikkan stub). Insiden 2026-10-23.
      const fetchDetail = deps.fetchAnimeDetail || fetchAnimeDetail
      const detail = await fetchDetail(item.url)
      const combined = [
        ...(detail.episodeList || []).map(e => ({ label: e.label, url: e.url })),
        ...(detail.batchList || []).map(b => ({ label: `Batch — ${b.label}`, url: b.url }))
      ]
      if (!combined.length) return { type: 'view', text: `🎬 *${detail.title || item.title}*\n\nBelum ada episode/batch tersedia untuk judul ini.` }
      return {
        type: 'view',
        text: formatEpisodesView({ ...detail, _combined: combined }),
        flow: { stage: 'episodes', title: detail.title, items: combined }
      }
    }
    case 'episodes':
      return openEpisode(item.url, deps)
    case 'providers': {
      const detect = deps.detectProvider || registryDetect
      const engineId = safeDetect(detect, item.url)
      if (!isDownloadableEntry(item, engineId)) {
        const why = engineId === 'kdrive'
          ? 'Entri kDrive MKV tidak punya pasangan streaming (resolusi kDrive hanya untuk MP4), jadi tidak bisa diresolusi bot.'
          : 'Provider ini belum punya engine di bot.'
        return { type: 'link', url: item.url, text: `🔗 ${why} Ini link mentahnya:\n${item.url}` }
      }
      if (engineId === 'kdrive') {
        const resolve = deps.resolveKdrive || resolveKdrive
        const info = await resolve(item.url, { episodeUrl: flow.episodeUrl })
        return { type: 'download', provider: 'kdrive', url: info.fileUrl }
      }
      return { type: 'download', provider: engineId, url: item.url }
    }
    default:
      throw new Error('Tahap alur tidak dikenal — mulai lagi dari .ongoing, .carianime, atau .anime.')
  }
}

export { ensureEngines, openEpisode as openEpisodeFlow }
