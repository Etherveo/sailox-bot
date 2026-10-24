// Mesin di balik perintah .cariplugin (adaptasi owner-cariplugin.js legacy):
// mencari sebuah string di dalam isi file-file plugin.
//
// Perbedaan sadar dari legacy, mengikuti pola engine sekarang:
// - Folder plugins dipindai REKURSIF (plugins/<kategori>/*.js, bukan datar).
// - Filter kategori memakai format .listplugin (satu / rentang abjad /
//   multi koma), ditulis DALAM KURUNG sebelum keyword: .cp (owner) jid
// - Keyword bebas: multi-kata dan multi-baris (lihat parseSearchArgs).
// - Flag -s sebelum keyword/filter = pencarian case-sensitive.
import fs from 'node:fs/promises'
import path from 'node:path'
import { listPluginFiles } from './pluginReplace.js'

// Pilihan kategori dari teks perintah (format sama seperti .listplugin):
// - kosong            -> semua kategori
// - `owner`           -> satu kategori
// - `main-owner`      -> rentang kategori menurut urutan abjad, inklusif di kedua ujung
// - `owner, main`     -> beberapa kategori tertentu saja
export function selectCategories(categories, text) {
  const raw = (text ?? '').trim().toLowerCase()
  if (!raw) return null
  const sorted = [...categories].sort()
  if (raw.includes(',')) {
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean)
    if (!parts.length) throw 'Format kategori tidak valid.'
    for (const p of parts) if (!sorted.includes(p)) throw `Kategori tidak ditemukan: ${p}`
    return new Set(parts)
  }
  if (raw.includes('-')) {
    const seg = raw.split('-').map(s => s.trim())
    if (seg.length !== 2 || !seg[0] || !seg[1]) throw 'Format rentang: .cp <kata_kunci> <kategoriAwal>-<kategoriAkhir>'
    for (const p of seg) if (!sorted.includes(p)) throw `Kategori tidak ditemukan: ${p}`
    let i = sorted.indexOf(seg[0]), j = sorted.indexOf(seg[1])
    if (i > j) [i, j] = [j, i]
    return new Set(sorted.slice(i, j + 1))
  }
  if (!sorted.includes(raw)) throw `Kategori tidak ditemukan: ${raw}`
  return new Set([raw])
}

// Format argumen (ditetapkan founder, urutannya kaku):
//   .cp <keyword bebas>
//   .cp -s <keyword bebas>
//   .cp [-s] (<filter>) <keyword bebas>
// Pembersihan input menentukan filter mana yang berlaku:
// 1. Flag -s di paling depan (berdiri sendiri) = pencarian case-sensitive.
// 2. Kelompok kurung PERTAMA sesudahnya dibaca sebagai filter kategori
//    HANYA bila isinya lolos selectCategories (satu / rentang main-owner /
//    multi owner, main). Bila isinya bukan kategori yang sah, kurung itu
//    dianggap bagian dari keyword.
// 3. Keyword = sisa teks APA ADANYA (multi-kata, multi-baris, boleh
//    mengandung kurung lagi) — tidak dipotong-potong lagi.
export function parseSearchArgs(text, available = []) {
  let s = String(text ?? '').trim()
  let sensitive = false
  if (/^-s(?=\s|\(|$)/i.test(s)) {
    sensitive = true
    s = s.slice(2).trimStart()
  }
  let categories = null
  let filterText = ''
  if (s.startsWith('(')) {
    const close = s.indexOf(')')
    if (close >= 1) {
      const inside = s.slice(1, close).trim()
      let selected
      try { selected = selectCategories(available, inside) } catch { selected = undefined }
      if (selected !== undefined) {
        categories = selected
        filterText = inside
        s = s.slice(close + 1).trimStart()
      }
    }
  }
  if (!s) return null
  return { keyword: s, sensitive, categories, filterText }
}

export function categoryOf(rel) {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '(root)' : rel.slice(0, i)
}

// Cari string di isi file plugin. Mengembalikan [{ file, count }],
// diurutkan dari kemunculan terbanyak.
export async function searchPlugins({ pluginsDir, keyword, sensitive = false, categories = null }) {
  const needle = sensitive ? keyword : keyword.toLowerCase()
  const matches = []
  for (const rel of await listPluginFiles(pluginsDir)) {
    if (categories && !categories.has(categoryOf(rel).toLowerCase())) continue
    const content = await fs.readFile(path.join(pluginsDir, rel), 'utf8')
    const hay = sensitive ? content : content.toLowerCase()
    let count = 0, idx = 0
    while ((idx = hay.indexOf(needle, idx)) >= 0) { count++; idx += needle.length }
    if (count) matches.push({ file: rel, count })
  }
  matches.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
  return matches
}
