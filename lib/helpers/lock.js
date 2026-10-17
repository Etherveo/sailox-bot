export class KeyedLock {
  constructor() { this.pending = new Map() }
  async run(key, fn) {
    const previous = this.pending.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(fn)
    this.pending.set(key, next)
    try { return await next } finally { if (this.pending.get(key) === next) this.pending.delete(key) }
  }
}
