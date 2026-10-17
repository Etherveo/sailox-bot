import { jadibotCommand } from '#lib/helpers/jadibotCommands.js'
let handler = async (m, ctx) => jadibotCommand(m, ctx)
handler.help = ['approveplugin session@nomor requestId konfirmasi']; handler.tags = ['owner']; handler.command = /^approveplugin$/i; handler.owner = true; handler.private = true
export default handler
