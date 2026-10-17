import { moderate } from '#lib/helpers/moderation.js'
let handler = async (m, ctx) => moderate(m, ctx)
handler.help = ['unbanuser [target]']; handler.tags = ['owner']; handler.command = /^unbanuser$/i; handler.owner = true
export default handler
