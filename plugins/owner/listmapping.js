// .listmapping / .lmp — daftar semua mapping nama file anime.
// Porting legacy owner-listmapping.js.
import { activeAnimeNameMap } from '#lib/helpers/animeNameMap.js'

let handler = async (m) => {
  const entries = Object.entries(activeAnimeNameMap().list())
  if (!entries.length) return m.reply('📭 Belum ada mapping anime.')

  let output = `📚 *Daftar Anime Name Mapping*\n\n`
  output += entries.map(([key, data], i) => {
    let line = `${i + 1}. *${key}*\n   • Title: ${data.title}`
    if (data.season) line += `\n   • Season: ${data.season}`
    if (data.subtitle) line += `\n   • Subtitle: ${data.subtitle}`
    return line
  }).join('\n\n')

  m.reply(output)
}

handler.help = ['listmapping/lmp']
handler.tags = ['owner']
handler.command = /^l(ist)?m(ap)?p(ing)?$/i
handler.founder = true

export default handler
