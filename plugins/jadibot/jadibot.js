import { jadibotCommand } from '#lib/helpers/jadibotCommands.js'
let handler = async (m, ctx) => jadibotCommand(m, ctx)
handler.help = ['jadibot [nomor/id]']; handler.tags = ['jadibot']; handler.command = /^jadibot$/i
handler.private = true
export default handler
