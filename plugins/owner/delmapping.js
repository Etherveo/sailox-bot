// .delmapping / .dmp — hapus satu mapping nama file anime.
// Porting legacy owner-delmapping.js.
import { activeAnimeNameMap } from '#lib/helpers/animeNameMap.js'

let handler = async (m, { text, usedPrefix, command }) => {
  if (!text) throw `Format:\n${usedPrefix + command} KEYWORD`

  const key = text.trim()
  if (!activeAnimeNameMap().remove(key)) {
    return m.reply(`❌ Mapping dengan key *${key}* tidak ditemukan.`)
  }
  m.reply(`🗑️ Mapping *${key}* berhasil dihapus.`)
}

handler.help = ['delmapping/dmp Key']
handler.tags = ['owner']
handler.command = /^d(el(ete)?)?m(ap)?p(ing)?$/i
handler.founder = true

export default handler
