import { jadibotCommand } from '#lib/helpers/jadibotCommands.js'
let handler = async (m, ctx) => jadibotCommand(m, ctx)
handler.help = ['deljadibot [nomor/id]']; handler.tags = ['jadibot']; handler.command = /^deljadibot$/i
handler.private = true
export default handler
