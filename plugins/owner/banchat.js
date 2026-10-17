import { moderate } from '#lib/helpers/moderation.js'
let handler = async (m, ctx) => moderate(m, ctx)
handler.help = ['banchat [target]']; handler.tags = ['owner']; handler.command = /^banchat$/i; handler.owner = true
export default handler
