// Mesin di balik perintah .replace (adaptasi owner-replace.js legacy):
// ganti sebuah kata/frasa di SEMUA file plugin sekaligus.
//
// Perbedaan sadar dari legacy, mengikuti pola engine sekarang:
// - Folder plugins dipindai REKURSIF (engine sekarang berkategori:
//   plugins/<kategori>/*.js, bukan datar seperti legacy).
// - Setiap file yang berubah divalidasi syntax-nya (acorn, sama seperti
//   gerbang .saveplugin) SEBELUM ditulis — file yang hasil gantinya rusak
//   dilewati dan dilaporkan, tidak ditulis setengah-setengah.
// - Pemisah "|" hanya yang PERTAMA yang dipakai, jadi kata baru boleh
//   mengandung "|" juga.
import fs from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'acorn'

export function parseReplaceArgs(text) {
  const raw = String(text ?? '')
  const idx = raw.indexOf('|')
  if (idx < 0) return null
  const oldStr = raw.slice(0, idx).trim()
  const newStr = raw.slice(idx + 1).trim()
  if (!oldStr || !newStr) return null
  return { oldStr, newStr }
}

export function countOccurrences(content, needle) {
  return content.split(needle).length - 1
}

export function syntaxOk(code) {
  try { parse(code, { ecmaVersion: 'latest', sourceType: 'module' }); return true } catch { return false }
}

export async function listPluginFiles(pluginsDir) {
  const out = []
  const walk = async (dir, prefix) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel)
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(rel)
    }
  }
  await walk(pluginsDir, '')
  return out.sort()
}

export async function replaceInPlugins({ pluginsDir, oldStr, newStr }) {
  const edited = []
  const skipped = []
  let total = 0
  for (const rel of await listPluginFiles(pluginsDir)) {
    const full = path.join(pluginsDir, rel)
    const content = await fs.readFile(full, 'utf8')
    const count = countOccurrences(content, oldStr)
    if (!count) continue
    const replaced = content.replaceAll(oldStr, newStr)
    if (!syntaxOk(replaced)) { skipped.push({ file: rel, count }); continue }
    await fs.writeFile(full, replaced)
    edited.push({ file: rel, count })
    total += count
  }
  return { edited, skipped, total }
}
