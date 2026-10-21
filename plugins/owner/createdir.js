import { ownerFileCommands } from '#lib/helpers/fileCommands.js'
let handler = async (m, ctx) => ownerFileCommands(m, ctx)
handler.help = ['mkdir <nama folder>'];
handler.tags = ['owner'];
handler.command = /^(createdir|mkdir)$/i;
handler.owner = true
export default handler
