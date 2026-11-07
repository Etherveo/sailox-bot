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

/* ─── Akses & limit fitur anime ──────────────────────────────────────────── */
//
// Sejak 2026-11-05 fitur anime bukan founder-only lagi: akses dibuka untuk
// user whitelist (config `anime.users`, diatur founder via .config) di DM,
// dan di grup hanya pada grup whitelist (`anime.groups`). Founder/owner
// selalu lolos dan bebas limit. User whitelist dibatasi dua hal:
//   - cooldown 1 menit antara memulai alur (.ongoing/.carianime/.anime)
//     dan antara percobaan unduhan (.pilih tahap provider);
//   - kuota 3 unduhan berhasil per hari (hari menurut zona waktu bot).
// Langkah navigasi .pilih di tengah alur TIDAK kena cooldown — alur memang
// dirancang bertahap dan harus bisa dilanjutkan berurutan.
// Status limit disimpan di record user (animeLastAt, animeDlDay,
// animeDlCount) agar persisten melewati restart. Cek + reservasi kuota
// dilakukan sinkron tanpa await di antaranya (lihat reserveAnimeDownload)
// supaya dua handler yang beririsan tidak bisa sama-sama lolos.

export const ANIME_DAILY_LIMIT = 3
export const ANIME_COOLDOWN_MS = 60 * 1000

export function animeDayKey(nowMs = Date.now(), timeZone) {
  const tz = timeZone || globalThis.timezone || 'Asia/Jakarta'
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs))
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10)
  }
}

const digitsOf = value => String(value ?? '').replace(/\D/g, '')

// Satu entri whitelist cocok bila: JID persis sama, ATAU resolver identitas
// bot menyatakan orang yang sama (PN <-> LID), ATAU digitnya persis sama
// (kasus pengirim PN vs entri nomor polos, dan pengirim LID vs entri LID
// polos — digit LID tidak pernah sama dengan nomor PN orang lain).
export function isAnimeWhitelisted(sender, entries, same) {
  if (!sender || !Array.isArray(entries)) return false
  for (const raw of entries) {
    const entry = String(raw ?? '').trim()
    if (!entry) continue
    const entryJid = entry.includes('@') ? entry : `${digitsOf(entry)}@s.whatsapp.net`
    if (entryJid === sender) return true
    if (typeof same === 'function') { try { if (same(entryJid, sender)) return true } catch { /* resolver gagal: lanjut ke pembanding digit */ } }
    if (digitsOf(entry) && digitsOf(entry) === digitsOf(sender)) return true
  }
  return false
}

export function animeAccess(m, ctx) {
  if (ctx?.isFounder || ctx?.isOwner) return { exempt: true, ok: true }
  const same = (a, b) => ctx?.conn?.identity?.same?.(a, b)
  if (!isAnimeWhitelisted(m?.sender, globalThis.anime?.users ?? [], same)) return { exempt: false, ok: false, reason: 'user' }
  if (m?.isGroup && !(globalThis.anime?.groups ?? []).includes(m.chat)) return { exempt: false, ok: false, reason: 'group' }
  return { exempt: false, ok: true }
}

export function assertAnimeAccess(m, ctx) {
  const a = animeAccess(m, ctx)
  if (a.ok) return a
  if (a.reason === 'group') throw '🔒 Fitur anime belum dibuka di grup ini. Minta founder menambahkan grup ini ke whitelist anime.groups lewat .config.'
  throw '🔒 Fitur anime hanya untuk user dalam whitelist. Minta founder menambahkan nomormu ke anime.users lewat .config.'
}

export function animeCooldownLeft(record, nowMs = Date.now()) {
  const last = Number(record?.animeLastAt) || 0
  const left = ANIME_COOLDOWN_MS - (nowMs - last)
  return left > 0 ? left : 0
}

export function assertAnimeCooldown(record, nowMs = Date.now()) {
  const left = animeCooldownLeft(record, nowMs)
  if (left > 0) throw `⏳ Cooldown anime: tunggu ${Math.ceil(left / 1000)} detik lagi.`
}

export function markAnimeUse(record, nowMs = Date.now()) { if (record) record.animeLastAt = nowMs }

export function animeDownloadsToday(record, nowMs = Date.now(), timeZone) {
  if (!record || record.animeDlDay !== animeDayKey(nowMs, timeZone)) return 0
  return Number(record.animeDlCount) || 0
}

// Cek kuota + naikkan penghitung dalam satu langkah sinkron (reservasi).
// Bila unduhan ternyata tidak menghasilkan file (hasil link-oversize atau
// job gagal), panggil releaseAnimeDownload untuk mengembalikan slotnya.
export function reserveAnimeDownload(record, nowMs = Date.now(), timeZone) {
  if (!record) return
  const today = animeDayKey(nowMs, timeZone)
  if (record.animeDlDay !== today) { record.animeDlDay = today; record.animeDlCount = 0 }
  if ((Number(record.animeDlCount) || 0) >= ANIME_DAILY_LIMIT) throw `📥 Kuota unduhan anime hari ini sudah habis (${ANIME_DAILY_LIMIT}/hari). Coba lagi besok.`
  record.animeDlCount = (Number(record.animeDlCount) || 0) + 1
}

export function releaseAnimeDownload(record, nowMs = Date.now(), timeZone) {
  if (!record || record.animeDlDay !== animeDayKey(nowMs, timeZone)) return
  record.animeDlCount = Math.max(0, (Number(record.animeDlCount) || 0) - 1)
}

export async function saveAnimeUser() {
  try { await globalThis.db?.save('users') } catch { /* autosave berkala tetap menangkap perubahan record */ }
}
