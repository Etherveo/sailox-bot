import { ownerFileCommands } from '#lib/helpers/fileCommands.js'
let handler = async (m, ctx) => ownerFileCommands(m, ctx)
handler.help = ['cd [path]'];
handler.tags = ['owner'];
handler.command = /^cd$/i;
handler.owner = true
export default handler
