import { jadibotCommand } from '#lib/helpers/jadibotCommands.js'
let handler = async (m, ctx) => jadibotCommand(m, ctx)
handler.help = ['stopjadibot [nomor/id]']; handler.tags = ['jadibot']; handler.command = /^stopjadibot$/i
handler.private = true
export default handler
