import { ownerPluginCRUD } from '#lib/helpers/ownerPluginCommands.js'
let handler = async (m, ctx) => ownerPluginCRUD(m, ctx)
handler.help = ['getplugin [-f] <nama|kategori-nama>'];
handler.tags = ['owner'];
handler.command = /^g(?:et)?p(?:lugin)?$/i;
handler.owner = true
export default handler
