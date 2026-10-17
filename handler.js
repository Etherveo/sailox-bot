export { dfail } from './lib/helpers/messages.js'
export async function handler(update) { return this.pipeline.handler.call(this, update) }
export async function participantsUpdate(update) { return this.pipeline.participantsUpdate.call(this, update) }
export async function groupsUpdate(updates) { return this.pipeline.groupsUpdate.call(this, updates) }
export async function deleteUpdate(update) { return this.pipeline.deleteUpdate.call(this, update) }
