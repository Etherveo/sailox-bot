let handler = async (m, { text }) => {
const q = m.quoted; if (q?.mediaType !== 'sticker' || !q.msg.fileSha256 || !text || text.length > 1000) throw 'Balas stiker dengan .setcmd <perintah>.'; const hash = Buffer.from(q.msg.fileSha256).toString('base64'), current = global.db.data.stickers[hash]; if (current?.locked) throw 'Perintah stiker dikunci.'; const row = global.db.ensure('stickers', hash); Object.assign(row, { creator: m.sender, text, mentionedJid: m.mentionedJid.slice(0, 20), at: Date.now() }); await global.db.save('stickers'); await m.reply('Perintah stiker disimpan.')
}
handler.help = ['setcmd <perintah>'];
handler.tags = ['tools'];
handler.command = /^setcmd$/i;
handler.premium = true
export default handler
