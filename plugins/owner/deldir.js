import { ownerFileCommands } from '#lib/helpers/fileCommands.js'
let handler = async (m, ctx) => ownerFileCommands(m, ctx)
handler.help = ['rmdir <nama folder>'];
handler.tags = ['owner'];
handler.command = /^(rm|del)dir$/i;
handler.owner = true
export default handler
