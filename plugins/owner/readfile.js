import { ownerFileCommands } from '#lib/helpers/fileCommands.js'
let handler = async (m, ctx) => ownerFileCommands(m, ctx)
handler.help = ['readfile <path|nomor>'];
handler.tags = ['owner'];
handler.command = /^r(ead)?f(ile)?$/i;
handler.owner = true
export default handler
