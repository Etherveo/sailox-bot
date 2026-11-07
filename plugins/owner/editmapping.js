// .editmapping / .emp — ubah sebagian field satu mapping.
// Porting legacy owner-editmapping.js: field yang dikosongkan berarti
// TIDAK diubah (mengikuti teks bantuan legacy; pengecekan title di
// legacy yang bertentangan dengan bantuannya tidak dibawa).
// Tambahan Sailox: isi field dengan "-" untuk MENGHAPUS field itu
// (season/subtitle; title tidak bisa dihapus).
import { activeAnimeNameMap } from '#lib/helpers/animeNameMap.js'

let handler = async (m, { text, usedPrefix, command }) => {
  if (!text) {
    throw `Format:\n${usedPrefix + command} Keyword | Title | Season | Subtitle\n\n(Kosongkan field jika tidak ingin diubah; isi "-" untuk menghapus field)`
  }
  const [key, title, season, subtitle] = text.split('|').map(v => v.trim())
  if (!key) throw 'Keyword wajib diisi.'

  const store = activeAnimeNameMap()
  const current = store.get(key)
  if (!current) throw `Mapping dengan key *${key}* tidak ditemukan.`

  const merged = { ...current }
  if (title) merged.title = title
  if (season === '-') delete merged.season
  else if (season) merged.season = season
  if (subtitle === '-') delete merged.subtitle
  else if (subtitle) merged.subtitle = subtitle

  const saved = store.edit(key, merged)
  m.reply(
    `✏️ Mapping berhasil diperbarui:\n\n` +
    `• Key: ${key}\n` +
    `• Title: ${saved.title}` +
    (saved.season ? `\n• Season: ${saved.season}` : '') +
    (saved.subtitle ? `\n• Subtitle: ${saved.subtitle}` : '')
  )
}

handler.help = ['editmapping/emp Key | Title | Season | Subtitle']
handler.tags = ['owner']
handler.command = /^e(dit)?m(ap)?p(ing)?$/i
handler.founder = true

export default handler
