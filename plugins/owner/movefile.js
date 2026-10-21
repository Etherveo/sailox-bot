import { ownerFileCommands } from '#lib/helpers/fileCommands.js'
let handler = async (m, ctx) => ownerFileCommands(m, ctx)
handler.help = ['movefile <file|nomor> | <folder tujuan>'];
handler.tags = ['owner'];
handler.command = /^(move(file)?|mv)$/i;
handler.owner = true
export default handler
