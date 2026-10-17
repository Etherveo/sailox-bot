let handler = async (m, { conn, text, participants }) => {
  const result = await conn.identity.resolve(text || m.sender, { m, participants })
  if (!result) throw 'Target tidak ditemukan.'
  await m.reply(`LID: ${result.lid || 'belum diketahui'}\nJID: ${result.jid || 'belum diketahui'}`)
}
handler.help = ['getlid [nomor/mention]']; handler.tags = ['info']; handler.command = /^getlid$/i
export default handler
