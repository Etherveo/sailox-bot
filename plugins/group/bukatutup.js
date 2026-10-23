// Buka/tutup grup — adaptasi group-settings.js legacy (mode announcement):
// grup tertutup = hanya admin yang bisa kirim pesan; grup terbuka = semua
// member bisa kirim pesan.
let handler = async (m, { conn, command }) => {
  const open = /^opengc$/i.test(command)
  await conn.groupSettingUpdate(m.chat, open ? 'not_announcement' : 'announcement')
  await m.reply(open ? '🔓 Grup dibuka — semua member bisa kirim pesan.' : '🔒 Grup ditutup — hanya admin yang bisa kirim pesan.')
}
handler.help = ['opengc', 'closegc']; handler.tags = ['group']; handler.command = /^(opengc|closegc)$/i
handler.group = true; handler.admin = true; handler.botAdmin = true
export default handler
