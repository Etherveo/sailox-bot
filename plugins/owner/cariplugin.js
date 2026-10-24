// .cariplugin — adaptasi owner-cariplugin.js legacy: mencari sebuah string
// di dalam isi file plugin. Keyword bebas (multi-kata/multi-baris);
// filter kategori ditulis dalam kurung sebelum keyword (format kategori
// sama seperti .listplugin: satu / rentang main-owner / multi owner, main);
// flag -s untuk pencarian case-sensitive (bawaan: insensitive).
//
// Contoh:
//   .cp sailox
//   .cp -s Sailox Bot
//   .cp (owner) getplugin
//   .cp -s (main-owner) conn.sendMessage
import path from 'node:path'
import { parseSearchArgs, categoryOf, searchPlugins } from '#lib/helpers/pluginSearch.js'
import { listPluginFiles } from '#lib/helpers/pluginReplace.js'
let handler = async (m, { conn, text }) => {
  if (conn.role === 'sub') throw 'Perintah ini hanya untuk bot utama.'
  try {
    const root = path.resolve(global.pluginLoader.root)
    const categories = new Set([...new Set((await listPluginFiles(root)).map(categoryOf))].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())))
    const parsed = parseSearchArgs(text, [...categories].map(c => c.toLowerCase()))
    if (!parsed) throw '🔍 Masukkan kata kunci.\nContoh: *.cariplugin sailox*\nFormat:\n*.cp <keyword bebas>*\n*.cp -s <keyword bebas>*\n*.cp [-s] (<kategori>) <keyword bebas>*'
    const { keyword, sensitive, categories: selected } = parsed
    const matches = await searchPlugins({ pluginsDir: root, keyword, sensitive, categories: selected })
    if (!matches.length) throw `❌ Tidak ada plugin yang mengandung *"${keyword}"*.`
    const shown = selected ? ` (kategori: ${[...selected].join(', ')})` : ''
    const sensNote = sensitive ? ' [case-sensitive]' : ''
    const body = matches.map(({ file, count }) => `  • ${path.basename(file, '.js')} _[${file}]_ — ${count}×`).join('\n')
    await m.reply(`🔍 Ditemukan *${matches.length}* plugin yang mengandung *"${keyword}"*${sensNote}${shown}:\n${body}`)
  } catch (e) { throw typeof e === 'string' ? e : `Pencarian plugin gagal: ${e.message}` }
}
handler.help = ['cariplugin [-s] [(kategori)] <keyword bebas>'];
handler.tags = ['owner'];
handler.command = /^(c(ari)?p(lugin)?|pluginsearch)$/i;
handler.owner = true
export default handler
