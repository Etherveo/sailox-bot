import { ownerFileCommands } from '#lib/helpers/fileCommands.js'
let handler = async (m, ctx) => ownerFileCommands(m, ctx)
handler.help = ['editfile <file> | <teks lama> | <teks baru>'];
handler.tags = ['owner'];
handler.command = /^e(dit)?f(ile)?$/i;
handler.owner = true
export default handler
