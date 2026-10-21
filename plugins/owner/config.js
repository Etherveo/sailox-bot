import { configCommand } from '#lib/helpers/configCommands.js'
let handler = async (m, ctx) => configCommand(m, ctx)
handler.help = ['config [list|get|set|del] <key> [nilai]'];
handler.tags = ['owner'];
handler.command = ['config', 'cfg'];
handler.founder = true
export default handler
