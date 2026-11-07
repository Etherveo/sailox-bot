// .addkey/.delkey/.edkey/.listkey + auto-respon keyword.
// Porting legacy plugins/store-keyword.js; tag diubah store -> fun
// (perintah Veo 2026-11-07), gate tetap owner-only seperti legacy.
// Store di src/private/JSONs/keyword-store.json — file mandiri di luar
// databases/, jadi tidak bersinggungan dengan mesin Database (yang
// memuat collection berdasarkan daftar nama, bukan pindaian folder).
// Tulis atomik (tmp + rename) dan sinkron: file kecil, dan rangkaian
// baca-ubah-tulis tanpa jeda await tidak bisa balapan di satu proses.
// File korup TIDAK ditimpa diam-diam: load melempar error jelas.
// Seluruh logic fitur ini tinggal di file plugin ini (aturan arsitektur
// AGENTS.md §12): tidak ada helper baru, karena hanya plugin ini yang
// memakai store keyword.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const KEYWORD_STORE_REL_PATH = path.join('src', 'private', 'JSONs', 'keyword-store.json')

function defaultProjectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function normalizeKey(key) {
  const k = String(key ?? '').trim().toLowerCase()
  if (!k) throw new Error('Keyword tidak boleh kosong.')
  if (UNSAFE_KEYS.has(k)) throw new Error('Keyword tidak valid.')
  return k
}

export function createKeywordStore({ filePath } = {}) {
  const file = filePath ?? path.join(defaultProjectRoot(), KEYWORD_STORE_REL_PATH)

  function load() {
    let raw
    try { raw = fs.readFileSync(file, 'utf8') }
    catch (e) { if (e.code === 'ENOENT') return {}; throw e }
    let data
    try { data = JSON.parse(raw) }
    catch (e) { throw new Error(`File store keyword rusak (JSON tidak valid): ${file}`, { cause: e }) }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`File store keyword rusak (harus objek JSON): ${file}`)
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

  // Tambah atau timpa (semantik legacy addkey).
  function add(key, value) {
    const k = normalizeKey(key)
    const v = String(value ?? '').trim()
    if (!v) throw new Error('Keyword atau respon gak boleh kosong')
    const map = load()
    map[k] = v
    save(map)
    return v
  }

  function edit(key, value) {
    const k = normalizeKey(key)
    const v = String(value ?? '').trim()
    if (!v) throw new Error('Keyword atau respon gak boleh kosong')
    const map = load()
    if (!Object.hasOwn(map, k)) throw new Error('Keyword tidak ditemukan.')
    map[k] = v
    save(map)
    return v
  }

  function remove(key) {
    const k = normalizeKey(key)
    const map = load()
    if (!Object.hasOwn(map, k)) return false
    delete map[k]
    save(map)
    return true
  }

  return { filePath: file, load, list, get, add, edit, remove }
}

export const keywordStore = createKeywordStore()

// Titik injeksi tes (pola yang sama seperti animeNameMap): plugin selalu
// memakai store aktif ini, dan tes boleh menggantinya dengan store
// berkas sementara lewat globalThis.keywordStore.
export function activeKeywordStore() {
  return globalThis.keywordStore ?? keywordStore
}

let handler = async (m, { text, usedPrefix, command }) => {
  const store = activeKeywordStore()
  switch (command) {
    case 'addkey': {
      if (!text.includes('|')) throw `Salah, woy!\nGini: ${usedPrefix + command} keyword|respon`
      const [keyRaw, ...valArr] = text.split('|')
      const value = valArr.join('|').trim()
      if (!keyRaw.trim() || !value) throw 'Keyword atau respon gak boleh kosong'
      store.add(keyRaw, value)
      return m.reply(`✅ Keyword "${keyRaw.trim()}" ditambahkan!`)
    }
    case 'delkey': {
      if (!text.trim()) throw `Salah. Gini: ${usedPrefix + command} keyword`
      const key = text.trim().toLowerCase()
      if (!store.remove(key)) throw '❌ Keyword tidak ditemukan.'
      return m.reply(`✅ Keyword "${key}" dihapus.`)
    }
    case 'edkey': {
      if (!text.includes('|')) throw `Salah. Kek gini: ${usedPrefix + command} keyword|respon baru`
      const [keyRaw, ...valArr] = text.split('|')
      const key = keyRaw.trim().toLowerCase()
      const value = valArr.join('|').trim()
      if (!key || !value) throw 'Keyword atau respon gak boleh kosong'
      if (!store.get(key)) throw '❌ Keyword tidak ditemukan.'
      store.edit(key, value)
      return m.reply(`✅ Keyword "${key}" diperbarui.`)
    }
    case 'listkey': {
      const list = Object.keys(store.list()).sort((a, b) => a.localeCompare(b))
      if (!list.length) return m.reply('Belum ada keyword tersimpan.')
      return m.reply(`📦 *Daftar Keyword Tersimpan:*\n\n${list.map(k => `• ${k}`).join('\n')}`)
    }
  }
}

// Auto-respon: pesan teks biasa yang persis sama dengan sebuah keyword
// (tanpa peduli kapital) dibalas dengan responnya. Berjalan untuk semua
// pengirim — seperti legacy. Chat/user yang di-ban sudah disaring
// pipeline sebelum hook ini berjalan, jadi tidak dicek lagi di sini.
handler.before = async (m) => {
  if (m.fromMe) return false
  const text = (m.text ?? '').trim().toLowerCase()
  if (!text) return false
  const hit = activeKeywordStore().get(text)
  if (!hit) return false
  await m.reply(hit)
  return true
}

handler.help = ['addkey keyword|respon', 'delkey keyword', 'edkey keyword|respon baru', 'listkey']
handler.tags = ['fun']
handler.command = /^(add|del|ed|list)key$/i
handler.owner = true

export default handler
