import { moderate } from '#lib/helpers/moderation.js'
let handler = async (m, ctx) => moderate(m, ctx)
handler.help = ['unbanchat [target]']; handler.tags = ['owner']; handler.command = /^unbanchat$/i; handler.owner = true
export default handler
