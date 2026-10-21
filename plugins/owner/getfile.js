import { ownerFileCommands } from '#lib/helpers/fileCommands.js'
let handler = async (m, ctx) => ownerFileCommands(m, ctx)
handler.help = ['getfile <path|nomor>'];
handler.tags = ['owner'];
handler.command = /^getfile$/i;
handler.owner = true
export default handler
