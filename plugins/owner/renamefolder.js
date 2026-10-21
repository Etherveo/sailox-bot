import { ownerFileCommands } from '#lib/helpers/fileCommands.js'
let handler = async (m, ctx) => ownerFileCommands(m, ctx)
handler.help = ['renamefolder <folder|nomor> | <nama baru>'];
handler.tags = ['owner'];
handler.command = /^r(e)?n(ame)?(fo(lder)?|dir(ektori)?)$/i;
handler.owner = true
export default handler
