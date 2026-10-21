import { ownerEngineCRUD } from '#lib/helpers/engineCommands.js'
let handler = async (m, ctx) => ownerEngineCRUD(m, ctx)
handler.help = ['deleteengine <nama>']
handler.tags = ['owner']
handler.command = /^(deleteengine|delengine|de)$/i
handler.owner = true
export default handler
