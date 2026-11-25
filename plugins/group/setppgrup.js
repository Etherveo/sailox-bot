// Ganti foto profil grup — adaptasi group-setppgc.js legacy. Gambar dari
// lampiran perintah ini sendiri atau dari pesan bergambar yang di-reply.
let handler = async (m, { conn, usedPrefix, command }) => {
  const q = m.mtype === 'imageMessage' ? m : m.quoted
  const mime = q?.msg?.mimetype || (q?.mtype === 'imageMessage' ? 'image' : '')
  if (!q || !/image/.test(mime)) throw `Kirim/reply gambar dengan caption *${usedPrefix + command}*`
  const img = await q.download()
  if (!img) throw 'Fotonya mana? Gagal mengunduh gambarnya.'
  await conn.updateProfilePicture(m.chat, img)
  await m.reply('✅ Foto profil grup diganti.')
}
handler.help = ['setppgrup (kirim/reply gambar)']; handler.tags = ['group']; handler.command = /^(setppgrup|setppgc)$/i
handler.group = true; handler.admin = true; handler.botAdmin = true
export default handler
