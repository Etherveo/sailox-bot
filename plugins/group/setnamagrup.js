// Ganti nama (subject) grup — adaptasi group-setnamegc.js legacy.
// Teks saja (emoji didukung), maksimal 100 karakter sesuai batas WhatsApp
// untuk nama grup; dihitung per poin kode Unicode supaya emoji tidak
// terhitung dobel. Nama grup selalu satu baris.
let handler = async (m, { conn, text, usedPrefix, command }) => {
  const name = String(text ?? '').replace(/\s*\n\s*/g, ' ').trim()
  if (!name) throw `Nama barunya apa?\nContoh: ${usedPrefix + command} Velaryna 🎉`
  const count = [...name].length
  if (count > 100) throw `Kepanjangan: ${count} karakter. Nama grup maksimal 100 karakter (termasuk spasi) — potong ${count - 100} karakter lagi (cek pakai .ukur).`
  await conn.groupUpdateSubject(m.chat, name)
  await m.reply(`✅ Nama grup diganti jadi: ${name}`)
}
handler.help = ['setnamagrup <nama baru>']; handler.tags = ['group']; handler.command = /^(setnamagrup|setnamagc)$/i
handler.group = true; handler.admin = true; handler.botAdmin = true
export default handler
