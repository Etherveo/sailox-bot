import path from 'node:path'
import { reactTo, REACT } from '#lib/helpers/react.js'
import { renderBratPng, BRAT_MAX_CHARS } from '#lib/media/brat.js'
import { mediaToSticker } from '#lib/media/sticker.js'
import { requestBrat } from '#lib/subbot/convertClient.js'
// .brat <teks> — stiker teks gaya brat (adaptasi sticker-brat.js legacy
// yang berbasis canvas; di sini metrik TTF + ffmpeg, lihat
// lib/media/brat.js). Sumber teks, urut prioritas:
//   1. teks sesudah perintah (termasuk caption media: ".brat ..." yang
//      ditulis sebagai caption gambar perintah itu sendiri)
//   2. caption pesan yang di-reply (m.quoted.caption)
//   3. teks pesan yang di-reply (perilaku legacy)
let handler = async (m, { conn, text, __dirname }) => {
  let content = String(text ?? '').trim() || String(m.quoted?.caption ?? '').trim() || String(m.quoted?.text ?? '').trim()
  // Keunikan legacy: kalau teks hasil reply adalah perintah .brat lain,
  // ambil isinya saja.
  if (content.startsWith('.')) {
    const after = content.toLowerCase().split('brat')[1]
    if (after) content = after.trim()
  }
  if (!content) throw 'Contoh: .brat kapan nikah? — atau reply pesan/caption media apa pun dengan .brat'
  if ([...content].length > BRAT_MAX_CHARS) throw `Teks terlalu panjang! Maksimal ${BRAT_MAX_CHARS} karakter`
  await reactTo(m, REACT.processing).catch(() => {})
  // Sub-bot: worker tidak bisa spawn ffmpeg, jadi render dilempar ke
  // bot utama lewat channel IPC (auto-approve, validasi berlapis —
  // lib/subbot/convertClient.js — requestBrat). pack/author 'Brat'/
  // nama bot sudah ditanam manager saat mediaToSticker, jadi tidak ada
  // yang perlu di-stamp di sini. Cabang ini tidak menyentuh render
  // lokal, mediaToSticker, maupun file font.
  if (conn.role === 'sub') {
    const { buffer: sticker } = await requestBrat(content)
    await conn.sendMessage(m.chat, { sticker }, { quoted: m })
    await reactTo(m, REACT.done).catch(() => {})
    return
  }
  const root = path.resolve(__dirname, '..', '..')
  const png = await renderBratPng(content, { root })
  const sticker = await mediaToSticker(png, { kind: 'image', root, packname: 'Brat', author: global.namebot || 'Sailox' })
  await conn.sendMessage(m.chat, { sticker }, { quoted: m })
  // ✅ menimpa ⏳ di pesan peminta (bukan di stiker hasil) — pola yang
  // ditetapkan founder: react selesai selalu ke pesan request.
  await reactTo(m, REACT.done).catch(() => {})
}
handler.help = ['brat <teks>', 'brat (reply teks/caption)']; handler.tags = ['sticker']; handler.command = /^brat$/i
handler.limit = true
// Dibagikan ke sub-bot: render jalan lewat channel bot utama
// (lib/subbot/convertClient.js — requestBrat) — worker tetap tanpa
// child process.
handler.sharing = true
export default handler
