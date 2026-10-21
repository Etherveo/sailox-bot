import fs from 'node:fs/promises'
import path from 'node:path'
async function scan(root, rel = '') {
  const out = []
  for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    if (e.isSymbolicLink()) throw 'Symlink plugin ditolak.'
    const id = rel ? rel + '/' + e.name : e.name
    if (e.isDirectory()) out.push(...await scan(root, id))
    else if (e.isFile() && e.name.endsWith('.js')) out.push(id)
  }
  return out.sort()
}
// Pilihan kategori dari teks perintah:
// - kosong            -> semua kategori
// - `owner`           -> satu kategori
// - `main-owner`      -> rentang kategori menurut urutan abjad, inklusif di kedua ujung
// - `owner, main`     -> beberapa kategori tertentu saja
function selectCategories(categories, text) {
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
    if (seg.length !== 2 || !seg[0] || !seg[1]) throw 'Format rentang: .lp <kategoriAwal>-<kategoriAkhir>'
    for (const p of seg) if (!sorted.includes(p)) throw `Kategori tidak ditemukan: ${p}`
    let i = sorted.indexOf(seg[0]), j = sorted.indexOf(seg[1])
    if (i > j) [i, j] = [j, i]
    return new Set(sorted.slice(i, j + 1))
  }
  if (!sorted.includes(raw)) throw `Kategori tidak ditemukan: ${raw}`
  return new Set([raw])
}
let handler = async (m, { conn, text }) => {
  if (conn.role === 'sub') throw 'Perintah ini hanya untuk bot utama.'
  try {
    const root = path.resolve(global.pluginLoader.root), groups = new Map()
    for (const id of await scan(root)) {
      const i = id.lastIndexOf('/'), dir = i < 0 ? '(root)' : id.slice(0, i)
      groups.set(dir, [...(groups.get(dir) ?? []), path.basename(id, '.js')])
    }
    if (!groups.size) throw 'Belum ada plugin.'
    const selected = selectCategories([...groups.keys()], text)
    const shown = [...groups].filter(([dir]) => !selected || selected.has(dir.toLowerCase()))
    if (!shown.length) throw 'Tidak ada plugin pada kategori pilihan itu.'
    const total = shown.reduce((n, [, names]) => n + names.length, 0)
    const body = shown.map(([dir, names]) => `📂 *${dir}* (${names.length})\n${names.map(n => `  • ${n}`).join('\n')}`).join('\n\n')
    await m.reply(`${body}\n\nTotal: ${total} plugin di ${shown.length} kategori\nLihat kode: .getplugin kategori-nama`)
  } catch (e) { throw typeof e === 'string' ? e : `Operasi plugin gagal: ${e.message}` }
}
handler.help = ['listplugin [kategori|kategori-kategori|kategori, kategori]'];
handler.tags = ['owner'];
handler.command = /^l(?:ist)?p(?:lugin)?$/i;
handler.owner = true
export default handler
