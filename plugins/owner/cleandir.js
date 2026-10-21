import { ownerFileCommands } from '#lib/helpers/fileCommands.js'
let handler = async (m, ctx) => ownerFileCommands(m, ctx)
handler.help = ['cleandir [path]'];
handler.tags = ['owner'];
handler.command = /^(cleandir|cleanfolder)$/i;
handler.owner = true
export default handler
