import { pluginCRUD } from '#lib/helpers/pluginCommands.js'
let handler = async (m, ctx) => pluginCRUD(m, ctx)
handler.help = ['saveplugin <nama>'];
handler.tags = ['owner'];
handler.command = /^s(?:ave)?p(?:lugin)?$/i;
handler.owner = true
export default handler
