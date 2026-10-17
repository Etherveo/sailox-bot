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
let handler = async (m, { conn, args }) => {
  if (conn.role === 'sub') throw 'Perintah ini hanya untuk bot utama.'
  try {
    const root = path.resolve(global.pluginLoader.root), filter = args[0]?.toLowerCase(), groups = new Map()
    for (const id of await scan(root)) {
      const i = id.lastIndexOf('/'), dir = i < 0 ? '(root)' : id.slice(0, i)
      if (filter && dir.toLowerCase() !== filter) continue
      groups.set(dir, [...(groups.get(dir) ?? []), path.basename(id, '.js')])
    }
    if (!groups.size) throw filter ? `Kategori tidak ditemukan: ${filter}` : 'Belum ada plugin.'
    const total = [...groups.values()].reduce((n, l) => n + l.length, 0)
    const body = [...groups].map(([dir, names]) => `📂 *${dir}* (${names.length})\n${names.map(n => `  • ${n}`).join('\n')}`).join('\n\n')
    await m.reply(`${body}\n\nTotal: ${total} plugin${filter ? '' : ` di ${groups.size} kategori`}\nLihat kode: .getplugin kategori/nama`)
  } catch (e) { throw typeof e === 'string' ? e : `Operasi plugin gagal: ${e.message}` }
}
handler.help = ['listplugin [kategori]'];
handler.tags = ['owner'];
handler.command = /^l(?:ist)?p(?:lugin)?$/i;
handler.owner = true
export default handler
