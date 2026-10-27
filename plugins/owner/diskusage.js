// plugins/owner/diskusage.js
//
// .du — port legacy plugins/owner-diskusage.js: hitung ukuran + jumlah
// file/folder sebuah path secara rekursif.
//
//   .du               -> root project bot
//   .du <path>        -> path relatif terhadap root project
//   .du <file>        -> satu file (files: 1)
//
// Aturan sailox (menyimpang dari legacy yang menerima path apa pun):
// path dijail ke root project, sessions/ ditolak, dan hanya bot utama
// (subbot tidak boleh mengintip disk host). Umpan balik proses memakai
// react ⏳ -> ✅ ala plugin sailox, bukan pesan "Processing" legacy.
import path from 'node:path'
import { diskUsage, DEFAULT_ROOT } from '#lib/helpers/diskUsage.js'
import { formatSize } from '#lib/helpers/diskUsage.js'
import { reactTo, REACT } from '#lib/helpers/react.js'

function projectRoot() {
  const pluginsRoot = global.pluginLoader?.root
  return pluginsRoot ? path.resolve(pluginsRoot, '..') : DEFAULT_ROOT
}

let handler = async (m, { conn, text }) => {
  if (conn?.role === 'sub') throw 'Perintah ini hanya untuk bot utama.'
  await reactTo(m, REACT.processing).catch(() => {})
  try {
    const result = await diskUsage(text, projectRoot())
    await m.reply([
      '📦 *Disk Usage*',
      `\`Path: ${result.path}\`\n`,
      `📊 Size: ${formatSize(result.size)}`,
      `📄 Files: ${result.files}`,
      `📁 Folders: ${result.dirs}`,
    ].join('\n'))
    await reactTo(m, REACT.done).catch(() => {})
  } catch (e) {
    await reactTo(m, REACT.error).catch(() => {})
    throw typeof e === 'string' ? e : e.message
  }
}

handler.help = ['du [path]']
handler.tags = ['owner']
handler.command = /^d(isk)?u(sage)?$/i
handler.owner = true

export default handler
