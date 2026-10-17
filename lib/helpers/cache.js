export class TTLCache {
  constructor({ max = 2000, ttl = 3600000, now = Date.now } = {}) { this.max = max; this.ttl = ttl; this.now = now; this.map = new Map() }
  get(key) {
    const e = this.map.get(key)
    if (!e) return undefined
    if (e.until <= this.now()) { this.map.delete(key); return undefined }
    this.map.delete(key); this.map.set(key, e)
    return e.value
  }
  set(key, value, ttl = this.ttl) {
    this.map.delete(key); this.map.set(key, { value, until: this.now() + ttl })
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value)
    return value
  }
  del(key) { return this.map.delete(key) }
  flushAll() { this.map.clear() }
  close() { this.flushAll() }
  get size() { for (const k of [...this.map.keys()]) this.get(k); return this.map.size }
}
