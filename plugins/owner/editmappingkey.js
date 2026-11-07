// .editmappingkey / .empk — ganti kunci satu mapping, isinya utuh.
// Porting legacy owner-editmappingkey.js.
import { activeAnimeNameMap } from '#lib/helpers/animeNameMap.js'

let handler = async (m, { text, usedPrefix, command }) => {
  if (!text) throw `Format:\n${usedPrefix + command} oldKey | newKey`

  const [key, nKey] = text.split('|').map(v => v.trim())
  if (!key || !nKey) throw 'Keduanya wajib diisi.'

  const store = activeAnimeNameMap()
  if (!store.get(key)) throw `Mapping dengan key *${key}* tidak ditemukan.`
  if (store.get(nKey)) throw `Key baru *${nKey}* sudah ada di mapping.`

  store.editKey(key, nKey)
  m.reply(
    `✏️ Mapping key berhasil diperbarui:\n\n` +
    `• Key lama: ${key}\n` +
    `• Key baru: ${nKey}`
  )
}

handler.help = ['editmappingkey oldKey | newKey']
handler.tags = ['owner']
handler.command = /^e(dit)?m(ap)?p(ing)?k(ey)?$/i
handler.founder = true

export default handler
