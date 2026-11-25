// Ambil link undangan grup ini — adaptasi group-link.js legacy.
let handler = async (m, { conn, groupMetadata }) => {
  const code = await conn.groupInviteCode(m.chat)
  if (!code) throw 'Gagal mengambil link grup.'
  await m.reply(`🔗 *${groupMetadata?.subject ?? 'Link grup'}*\nhttps://chat.whatsapp.com/${code}`)
}
handler.help = ['linkgc']; handler.tags = ['group']; handler.command = /^(linkgc|linkgrup|gclink)$/i
handler.group = true; handler.admin = true; handler.botAdmin = true
export default handler
