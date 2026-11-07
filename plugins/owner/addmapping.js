// .addmapping / .amp — tambah (atau timpa) satu mapping nama file anime.
// Porting legacy owner-addmapping.js; logika store di
// lib/helpers/animeNameMap.js (Fase 2 peta konsep .animedownload).
import { activeAnimeNameMap } from '#lib/helpers/animeNameMap.js'

let handler = async (m, { text, usedPrefix, command }) => {
  if (!text) {
    throw `Format:\n${usedPrefix + command} Keyword | Title | Season (opsional) | Subtitle (opsional)`
  }
  const [key, title, season, subtitle] = text.split('|').map(v => v.trim())
  if (!key || !title) throw 'Keyword dan Title wajib diisi.'

  const store = activeAnimeNameMap()
  const existed = store.get(key) != null
  const entry = store.add(key, { title, season, subtitle })

  m.reply(
    `✅ Mapping berhasil ${existed ? 'diperbarui (menimpa yang lama)' : 'ditambahkan'}:\n\n` +
    `• Key: ${key}\n` +
    `• Title: ${entry.title}` +
    (entry.season ? `\n• Season: ${entry.season}` : '') +
    (entry.subtitle ? `\n• Subtitle: ${entry.subtitle}` : '')
  )
}

handler.help = ['addmapping/amp Key | Title | Season | Subtitle']
handler.tags = ['owner']
handler.command = /^a(dd)?m(ap)?p(ing)?$/i
handler.founder = true

export default handler
