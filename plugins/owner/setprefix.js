import { validatePrefix } from '#lib/helpers/config.js'
let handler = async (m, { text, settings }) => { if (text === 'reset') settings.prefix = null; else { try { validatePrefix(text) } catch { throw 'Prefix tidak valid. Gunakan .setprefix ! atau .setprefix reset' } settings.prefix = text } await global.db.save('settings'); await m.reply('Prefix disimpan.') }
handler.help = ['setprefix <karakter|reset>']; handler.tags = ['owner']; handler.command = /^setprefix$/i; handler.owner = true
export default handler
