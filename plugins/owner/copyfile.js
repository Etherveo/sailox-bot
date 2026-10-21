import { ownerFileCommands } from '#lib/helpers/fileCommands.js'
let handler = async (m, ctx) => ownerFileCommands(m, ctx)
handler.help = ['copyfile <sumber|nomor> | <tujuan>'];
handler.tags = ['owner'];
handler.command = /^copyfile$/i;
handler.owner = true
export default handler
