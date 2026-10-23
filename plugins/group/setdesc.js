// Ganti deskripsi grup — adaptasi group-setdesc.js legacy. Teks bebas
// (boleh multi-baris & emoji). Batas resmi WhatsApp: 2048 karakter,
// dihitung apa adanya termasuk spasi (per poin kode Unicode, sama seperti
// .ukur) — ditegakkan di sini supaya tidak ada yang menyelipkan deskripsi
// raksasa. Ukur dulu pakai .ukur kalau ragu.
const MAX_DESC = 2048
let handler = async (m, { conn, text, usedPrefix, command }) => {
  const desc = String(text ?? '').trim()
  if (!desc) throw `Deskripsinya apa?\nContoh: ${usedPrefix + command} Grup santai, no spam. (Ukur dulu panjangnya pakai .ukur kalau ragu.)`
  const count = [...desc].length
  if (count > MAX_DESC) throw `Kepanjangan: ${count} karakter. Deskripsi grup maksimal ${MAX_DESC} karakter (termasuk spasi) — potong ${count - MAX_DESC} karakter lagi (cek pakai .ukur).`
  await conn.groupUpdateDescription(m.chat, desc)
  await m.reply(`✅ Deskripsi grup diperbarui (${count}/${MAX_DESC} karakter).`)
}
handler.help = ['setdesc <teks>']; handler.tags = ['group']; handler.command = /^(setdesc|sdesc)$/i
handler.group = true; handler.admin = true; handler.botAdmin = true
export default handler
