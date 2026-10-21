import { duration } from '#lib/helpers/time.js'
let handler = async m => { await m.reply(`Pong!\nUptime: ${duration(process.uptime() * 1000)}`) }
handler.help = ['ping'];
handler.tags = ['info'];
handler.command = /^p(?:ing)?$/i
export default handler