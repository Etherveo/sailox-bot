export async function before(m, { chat, isAdmin, isBotAdmin, isOwner, conn }) {
  if (!m.isGroup || !chat.antiLink || isAdmin || isOwner || !/https?:\/\/chat\.whatsapp\.com\//i.test(m.text)) return
  if (isBotAdmin) await conn.sendMessage(m.key.remoteJid, { delete: m.key })
  await m.reply('Tautan undangan grup tidak diizinkan di sini.')
}
