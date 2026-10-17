export class SubBotRegistry {
  constructor(db) { this.db = db }
  get(id) { return this.db.data.subbots[id] }
  list() { return Object.values(this.db.data.subbots) }
  async set(id, patch) { Object.assign(this.db.ensure('subbots', id), patch); await this.db.save('subbots'); return this.get(id) }
  async delete(id) { if (!Object.hasOwn(this.db.data.subbots, id)) throw new Error('Sub-bot tidak ditemukan'); delete this.db.data.subbots[id]; await this.db.save('subbots') }
}
