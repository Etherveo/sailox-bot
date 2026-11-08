// plugins/owner/kirim.js
//
// Port owner-kirim.js legacy (2026-11-08), disederhanakan atas perintah
// pemilik: versi legacy mengirim pesan tombol (footer nama pengirim,
// tombol "Do not touch", viewOnce, mention pertama) — di sini cukup
// conn.reply biasa. Perintah owner untuk menggemakan teks sebagai
// balasan bot; tanpa teks, teks bawaan legacy 'Sailox berkata'
// dipertahankan.

let handler = async (m, { conn, text }) => {
  const caption = String(text ?? '').trim() ? text : 'Sailox berkata'
  await conn.reply(m.chat, caption, m)
}

handler.help = ['kirim <teks>', 'k <teks>']
handler.tags = ['owner']
handler.command = /^(k(irim)?)$/i
handler.owner = true

export default handler
