// .ceknama — pratinjau nama final hasil mapping untuk satu nama file,
// tanpa mengunduh apa pun. Alat bantu mengisi/menguji mapping (Fase 2
// peta konsep .animedownload); logika di lib/helpers/animeNameMap.js.
import { activeAnimeNameMap } from '#lib/helpers/animeNameMap.js'

let handler = async (m, { text, usedPrefix, command }) => {
  if (!text) {
    throw `Format:\n${usedPrefix + command} <nama file>\n\nContoh: ${usedPrefix + command} Kuramanime-REDRIVER-05-720p.mp4`
  }

  const name = text.trim()
  const store = activeAnimeNameMap()
  const hit = store.findIn(name)
  if (!hit) return m.reply(`❌ Tidak ada mapping yang cocok untuk:\n${name}`)

  const resolved = store.resolve(name)
  if (!resolved) {
    return m.reply(
      `⚠️ Key *${hit.key}* cocok (Title: ${hit.entry.title}), tapi nama final tidak bisa disusun — ` +
      `nama file tidak membawa nomor episode atau label OVA/Special/Movie.`
    )
  }

  m.reply(`✅ *${hit.key}* → ${hit.entry.title}\n\n📄 Nama final:\n${resolved.name}`)
}

handler.help = ['ceknama <nama file>']
handler.tags = ['owner']
handler.command = /^ceknama$/i
handler.founder = true

export default handler
