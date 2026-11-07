import fs from 'node:fs/promises'
import path from 'node:path'
import { selectCategories } from '#lib/helpers/pluginSearch.js'
// Varian sub-bot dari plugins/owner/listplugin.js: logika pindai yang sama,
// tapi TANPA gerbang "hanya untuk bot utama" — di worker, pluginLoader.root
// adalah folder plugin sandbox sub-bot itu sendiri, jadi yang terdaftar
// hanya plugin milik sub-bot tersebut. Sengaja berdiri sendiri (bukan lewat
// pluginCRUD): helper itu hanya punya cabang save/get/delete, regex lp-nya
// tanpa cabang, jadi dibungkus pun perintahnya diam tanpa balasan.
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
let handler = async (m, { conn, text }) => {
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
handler.tags = ['tools'];
handler.command = /^l(?:ist)?p(?:lugin)?$/i;
handler.owner = true
export default handler
