export function all(m) {
  if (m.mediaType !== 'sticker' || !m.msg.fileSha256) return
  const command = global.db.data.stickers[Buffer.from(m.msg.fileSha256).toString('base64')]
  if (command) { m.text = command.text; m.mentionedJid = command.mentionedJid }
}
