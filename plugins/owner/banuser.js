import { moderate } from '#lib/helpers/moderation.js'
let handler = async (m, ctx) => moderate(m, ctx)
handler.help = ['banuser [target]']; handler.tags = ['owner']; handler.command = /^banuser$/i; handler.owner = true
export default handler
