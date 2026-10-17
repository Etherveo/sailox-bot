let handler = async (m, { command, settings }) => { settings.self = command === 'self'; await global.db.save('settings'); await m.reply(`Mode ${settings.self ? 'self' : 'public'} aktif.`) }
handler.help = ['self', 'public']; handler.tags = ['owner']; handler.command = /^(self|public)$/i; handler.owner = true
export default handler
