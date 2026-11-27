import { pluginCRUD } from '#lib/helpers/pluginCommands.js'
let handler = async (m, ctx) => pluginCRUD(m, ctx)
handler.help = ['getplugin <nama>']; handler.tags = ['owner']; handler.command = /^getplugin$/i; handler.owner = true
export default handler
