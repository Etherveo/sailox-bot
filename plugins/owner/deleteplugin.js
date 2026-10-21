import { ownerPluginCRUD } from '#lib/helpers/ownerPluginCommands.js'
let handler = async (m, ctx) => ownerPluginCRUD(m, ctx)
handler.help = ['deleteplugin <nama|kategori-nama>'];
handler.tags = ['owner'];
handler.command = /^d(?:el(?:ete)?)?p(?:lugin)?$/i;
handler.owner = true
export default handler
