import { ownerFileCommands } from '#lib/helpers/fileCommands.js'
let handler = async (m, ctx) => ownerFileCommands(m, ctx)
handler.help = ['copydir <folder|nomor> <tujuan>'];
handler.tags = ['owner'];
handler.command = /^copy(dir(ektori)?|folder)$/i;
handler.owner = true
export default handler
