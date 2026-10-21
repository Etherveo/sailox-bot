import { ownerFileCommands } from '#lib/helpers/fileCommands.js'
let handler = async (m, ctx) => ownerFileCommands(m, ctx)
handler.help = ['carifile <kata kunci> [filter ekstensi]'];
handler.tags = ['owner'];
handler.command = /^c(ari)?f(ile)?$/i;
handler.owner = true
export default handler
