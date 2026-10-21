import { ownerPluginCRUD } from '#lib/helpers/ownerPluginCommands.js'
let handler = async (m, ctx) => ownerPluginCRUD(m, ctx)
handler.help = ['saveplugin <nama|kategori-nama>'];
handler.tags = ['owner'];
handler.command = /^s(?:ave)?p(?:lugin)?$/i;
handler.owner = true
export default handler
