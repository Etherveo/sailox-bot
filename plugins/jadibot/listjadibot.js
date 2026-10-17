import { jadibotCommand } from '#lib/helpers/jadibotCommands.js'
let handler = async (m, ctx) => jadibotCommand(m, ctx)
handler.help = ['listjadibot [nomor/id]']; handler.tags = ['jadibot']; handler.command = /^listjadibot$/i
handler.owner = true
export default handler
