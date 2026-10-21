import { ownerEngineCRUD } from '#lib/helpers/engineCommands.js'
let handler = async (m, ctx) => ownerEngineCRUD(m, ctx)
handler.help = ['listengine']
handler.tags = ['owner']
handler.command = /^(listengine|le)$/i
handler.owner = true
export default handler
