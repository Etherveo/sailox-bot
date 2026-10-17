import { pluginCRUD } from '#lib/helpers/pluginCommands.js'
let handler = async (m, ctx) => pluginCRUD(m, ctx)
handler.help = ['getplugin <nama>'];
handler.tags = ['owner'];
handler.command = /^g(?:et)?p(?:lugin)?$/i;
handler.owner = true
export default handler
