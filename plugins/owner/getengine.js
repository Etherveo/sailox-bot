import { ownerEngineCRUD } from '#lib/helpers/engineCommands.js'
let handler = async (m, ctx) => ownerEngineCRUD(m, ctx)
handler.help = ['getengine <nama>']
handler.tags = ['owner']
handler.command = /^(getengine|ge)$/i
handler.owner = true
export default handler
