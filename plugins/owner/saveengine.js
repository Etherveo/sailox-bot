import { ownerEngineCRUD } from '#lib/helpers/engineCommands.js'
let handler = async (m, ctx) => ownerEngineCRUD(m, ctx)
handler.help = ['saveengine <nama> (balas kode/file .js)']
handler.tags = ['owner']
handler.command = /^(saveengine|se)$/i
handler.owner = true
export default handler
