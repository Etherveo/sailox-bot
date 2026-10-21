import { ownerFileCommands } from '#lib/helpers/fileCommands.js'
let handler = async (m, ctx) => ownerFileCommands(m, ctx)
handler.help = ['ls [path]'];
handler.tags = ['owner'];
handler.command = /^(ls|dir)$/i;
handler.owner = true
export default handler
