import { pluginCRUD } from '#lib/helpers/pluginCommands.js'
let handler = async (m, ctx) => pluginCRUD(m, ctx)
handler.help = ['saveplugin <nama>']; handler.tags = ['tools']; handler.command = /^saveplugin$/i; handler.owner = true
export default handler
