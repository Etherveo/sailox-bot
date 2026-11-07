// Mesin mapping nama file anime: store JSON + pencocok token + komposer
// nama final. Engine BERSAMA satu keluarga fitur — perintah mapping
// (.addmapping/.amp, .listmapping, .delmapping, .editmapping,
// .editmappingkey, .clearmapping) dan .animedownload — bukan helper
// satu fitur (aturan arsitektur AGENTS.md §12).
//
// Porting dari legacy (lib/anime-crud-mapper.js,
// lib/anime-filename-mapper.js, plugins/owner-npd.js) dengan keputusan
// Sailox 2026-11-07:
// - Store di src/private/JSONs/anime-map.json — di luar databases/,
//   jadi tidak bersinggungan dengan mesin Database (yang memuat
//   collection berdasarkan daftar nama, bukan pindaian folder).
// - Tulis atomik (tmp + rename) dan sinkron: file kecil, dan rangkaian
//   baca-ubah-tulis tanpa jeda await tidak bisa balapan di satu proses.
//   File korup TIDAK ditimpa diam-diam: load melempar error jelas.
// - Jalur seasonal/Jikan legacy TIDAK dibawa. Mapping murni manual
//   dari .amp; data awal diimpor sekali dari animeMap.json legacy.
// - Format nama baru: tag awalan [END], atau [NEW] khusus Episode 01
//   seri non-sekuel (deteksi sekuel memakai lib/helpers/seasonalParser.js
//   milik Veo); episode & resolusi terdeteksi dari nama asli, ekstensi
//   dari titik terakhir nama file.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAnimeTitle } from './seasonalParser.js'

function defaultProjectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export const ANIME_MAP_REL_PATH = path.join('src', 'private', 'JSONs', 'anime-map.json')

// Ekstensi menurut aturan Veo: ambil dari titik terakhir nama mentah.
export function extOf(name = '') {
  const s = String(name)
  const i = s.lastIndexOf('.')
  if (i <= 0) return ''
  const ext = s.slice(i)
  return ext.length <= 10 && !ext.includes('/') ? ext : ''
}

export function stripExt(name = '') {
  const ext = extOf(name)
  return ext ? String(name).slice(0, -ext.length) : String(name)
}

// Sanitasi judul gaya npd legacy: karakter terlarang nama file diganti
// padanan tampilannya, bukan dibuang.
// Normalisasi karakter tabu nama file pada judul mapping (tabel Veo
// 2026-11-07): judul mapping disimpan APA ADANYA; normalisasi terjadi
// di sini, saat nama dikomposisi — Veo tidak perlu lagi menyesuaikan
// judul secara manual saat mengisi .amp.
//   "  -> berpasangan: pembuka “, penutup ” ("teks" -> “teks”;
//         legacy mengganti semuanya jadi ”)
//   *  -> _      /  -> (spasi)  :  -> ;      ?  -> ¿
//   \  -> _      |  -> _
//   sisanya yang tabu (<, >, karakter kontrol) -> _
export function sanitizeTitle(title = '') {
  let quoteOpen = false
  return String(title)
    .replace(/"/g, () => { const q = quoteOpen ? '”' : '“'; quoteOpen = !quoteOpen; return q })
    .replace(/\*/g, '_')
    .replace(/\//g, ' ')
    .replace(/:/g, ';')
    .replace(/\?/g, '¿')
    .replace(/\\/g, '_')
    .replace(/\|/g, '_')
    .replace(/[<>\x00-\x1F\x7F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanSpaces(text = '') {
  return String(text)
    .replace(/\s+/g, ' ')
    .replace(/\s+([;,.!?¿])/g, '$1')
    .trim()
}

// Label dari nama asli: "Episode NN" dari nomor episode, atau label
// spesial OVA/Special/Movie (aturan mapper legacy). Tanpa keduanya,
// mapping dianggap TIDAK cocok (null) — sama seperti legacy.
export function parseEpisodeLabel(filename = '') {
  const base = stripExt(filename)
  const epMatch = base.match(/(?:^|[\s\-_\.])(?:ep|episode)?\s*(\d{1,3})(?=[\s\-_\.]|$)/i)
    || base.match(/(?:^|[\s\-_\.])(\d{1,3})(?=[\s\-_\.]|$)/)
  if (epMatch) {
    const n = epMatch[1].padStart(2, '0')
    return { kind: 'episode', number: n, label: `Episode ${n}` }
  }
  const special = base.match(/(?:^|[\s\-_\.])(ova|oad|special|sp|movie|mov|film)(?=[\s\-_\.]|$)/i)
  if (special) {
    const t = special[1].toLowerCase()
    const label = t === 'ova' || t === 'oad' ? 'OVA' : t === 'sp' || t === 'special' ? 'Special' : 'Movie'
    return { kind: 'special', number: null, label }
  }
  return null
}

// Sinyal tamat gaya npd: kata "end" sebagai token di nama asli.
// JANGAN pakai \b: dalam regex, "_" adalah karakter kata (\w), jadi
// \bend\b TIDAK cocok pada "13_end_720p" / "13_END_720p" — bug warisan
// legacy yang ditemukan Veo pada tes live 2026-11-07 (bentuk "-end-"
// lolos, bentuk "_end_" tidak). Batas non-alfanumerik seperti
// detectResolution menutupi semua gaya pemisah (-, _, ., spasi, kurung)
// tanpa false positive pada kata yang mengandung "end" (ENDLESS,
// LEGEND, Weekend).
export function isEndMarked(filename = '') {
  return /(?:^|[^0-9a-z])end(?![0-9a-z])/i.test(String(filename))
}

// Resolusi dari token seperti 720p/1080p di nama asli. Tidak terdeteksi
// -> null (segmen resolusi dihilangkan; JANGAN dipalsukan jadi 720p).
export function detectResolution(filename = '') {
  const m = String(filename).match(/(?:^|[^0-9a-z])(2160|1440|1080|720|480|360)p(?![0-9a-z])/i)
  return m ? `${m[1]}p` : null
}

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Pencocokan mapper legacy: kunci terpanjang didahulukan, kunci harus
// muncul sebagai token utuh (pemisah [-_. ], case-insensitive).
export function findMapping(filename = '', map = {}) {
  const entries = Object.entries(map || {}).sort((a, b) => b[0].length - a[0].length)
  for (const [key, entry] of entries) {
    const re = new RegExp(`(?:^|[-_. ])${escapeRegExp(key)}(?:[-_. ]|$)`, 'i')
    if (re.test(String(filename))) return { key, entry }
  }
  return null
}

// Susun nama final dari satu entri mapping + nama asli. Null bila nama
// asli tidak membawa label episode/spesial (mapping tidak cocok).
// Tag: [END] mengalahkan [NEW]; [NEW] HANYA untuk Episode 01 dari seri
// yang menurut seasonalParser bukan sekuel (koreksi Veo 2026-11-07 —
// npd legacy pun menggerbang [NEW] di episode 1 lewat isNewTag).
export function composeFromEntry(entry, originalName = '') {
  if (!entry?.title) return null
  const label = parseEpisodeLabel(originalName)
  if (!label) return null
  const titlePart = cleanSpaces(sanitizeTitle([entry.title, entry.season].filter(Boolean).join(' ')))
  const isSequel = parseAnimeTitle(titlePart).isSequel
  const isFirstEpisode = label.kind === 'episode' && Number(label.number) === 1
  const prefix = isEndMarked(originalName) ? '[END] ' : !isSequel && isFirstEpisode ? '[NEW] ' : ''
  const subtitle = sanitizeTitle(String(entry.subtitle ?? '').trim()) || 'Subtitle Indonesia'
  const resolution = detectResolution(originalName)
  const ext = extOf(originalName)
  return `${prefix}${titlePart} - ${label.label} ${subtitle}${resolution ? ` ${resolution}` : ''}${ext}`
}

function normalizeKey(key) {
  const k = String(key ?? '').trim()
  if (!k) throw new Error('Kunci mapping tidak boleh kosong.')
  return k
}

function normalizeEntry(data = {}) {
  const title = String(data.title ?? '').trim()
  if (!title) throw new Error('Title mapping tidak boleh kosong.')
  const entry = { title }
  const season = String(data.season ?? '').trim()
  if (season) entry.season = season
  const subtitle = String(data.subtitle ?? '').trim()
  if (subtitle) entry.subtitle = subtitle
  return entry
}

export function createAnimeNameMap({ filePath } = {}) {
  const file = filePath ?? path.join(defaultProjectRoot(), ANIME_MAP_REL_PATH)

  function load() {
    let raw
    try { raw = fs.readFileSync(file, 'utf8') }
    catch (e) { if (e.code === 'ENOENT') return {}; throw e }
    let data
    try { data = JSON.parse(raw) }
    catch (e) { throw new Error(`File mapping anime rusak (JSON tidak valid): ${file}`, { cause: e }) }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`File mapping anime rusak (harus objek JSON): ${file}`)
    }
    return data
  }

  function save(map) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  function list() { return load() }

  function get(key) {
    const map = load()
    return Object.hasOwn(map, key) ? map[key] : null
  }

  // Tambah atau timpa (semantik legacy addAnimeMapping).
  function add(key, data) {
    const k = normalizeKey(key)
    const entry = normalizeEntry(data)
    const map = load()
    map[k] = entry
    save(map)
    return entry
  }

  function edit(key, data) {
    const k = normalizeKey(key)
    const map = load()
    if (!Object.hasOwn(map, k)) throw new Error(`Mapping tidak ditemukan: ${k}`)
    map[k] = normalizeEntry(data)
    save(map)
    return map[k]
  }

  function editKey(oldKey, newKey) {
    const from = normalizeKey(oldKey)
    const to = normalizeKey(newKey)
    const map = load()
    if (!Object.hasOwn(map, from)) throw new Error(`Mapping tidak ditemukan: ${from}`)
    if (from !== to && Object.hasOwn(map, to)) throw new Error(`Kunci tujuan sudah dipakai: ${to}`)
    if (from !== to) { map[to] = map[from]; delete map[from]; save(map) }
    return map[to]
  }

  function remove(key) {
    const k = normalizeKey(key)
    const map = load()
    if (!Object.hasOwn(map, k)) return false
    delete map[k]
    save(map)
    return true
  }

  function clear() { save({}) }

  function findIn(filename) { return findMapping(filename, load()) }

  function resolve(filename) {
    const hit = findIn(filename)
    if (!hit) return null
    const name = composeFromEntry(hit.entry, filename)
    return name ? { ...hit, name } : null
  }

  return { filePath: file, load, list, get, add, edit, editKey, remove, clear, findIn, resolve }
}

export const animeNameMap = createAnimeNameMap()

// Titik injeksi tes (pola yang sama seperti fileCommands/sendGuard):
// plugin selalu memakai store aktif ini, dan tes boleh menggantinya
// dengan store berkas sementara lewat globalThis.animeNameMap.
export function activeAnimeNameMap() {
  return globalThis.animeNameMap ?? animeNameMap
}
export const listMappings = () => animeNameMap.list()
export const addMapping = (key, data) => animeNameMap.add(key, data)
export const editMapping = (key, data) => animeNameMap.edit(key, data)
export const editMappingKey = (oldKey, newKey) => animeNameMap.editKey(oldKey, newKey)
export const deleteMapping = key => animeNameMap.remove(key)
export const clearMappings = () => animeNameMap.clear()
export const resolveMappedName = filename => animeNameMap.resolve(filename)
