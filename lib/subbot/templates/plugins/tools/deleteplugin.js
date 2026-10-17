import { pluginCRUD } from '#lib/helpers/pluginCommands.js'
let handler = async (m, ctx) => pluginCRUD(m, ctx)
handler.help = ['deleteplugin <nama>']; handler.tags = ['tools']; handler.command = /^deleteplugin$/i; handler.owner = true
export default handler
