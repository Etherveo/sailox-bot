import { setTimeout as delay } from 'node:timers/promises'
import { KeyedLock } from './lock.js'
import { TTLCache } from './cache.js'

export class WorkQueue {
  constructor({ concurrency = 8, maxPending = 1000 } = {}) { this.concurrency = concurrency; this.maxPending = maxPending; this.active = 0; this.pending = []; this.count = 0; this.lock = new KeyedLock(); this.closed = false; this.idleWaiters = [] }
  async run(key, fn) {
    if (this.closed || this.count >= this.maxPending) throw new Error('Antrean penuh atau ditutup')
    this.count++
    try { return await this.lock.run(key, async () => {
      if (this.active >= this.concurrency) await new Promise(resolve => this.pending.push(resolve))
      else this.active++
      try { return await fn() } finally { const next = this.pending.shift(); if (next) next(); else this.active-- }
    }) } finally { this.count--; if (!this.count) this.idleWaiters.splice(0).forEach(r => r()) }
  }
  async drain() { if (this.count) await new Promise(resolve => this.idleWaiters.push(resolve)) }
  close() { this.closed = true; return this.drain() }
}
export class OutboundQueue {
  constructor({ perChatMs = 700, perSecond = 5, jitter = 0.1, now = Date.now, wait = delay, random = Math.random, maxPending = 500 } = {}) {
    // DUA JALUR (2026-11-19): 'text' dan 'media', concurrency 2 — satu teks
    // dan satu media boleh jalan bersamaan; di dalam satu jalur tetap serial
    // (KeyedLock per jalur) supaya urutan + rate-limit tiap jalur terjaga.
    // Sebelumnya satu jalur global ('outbound', concurrency 1): upload media
    // besar (bermenit-menit) menahan SEMUA kiriman lain — balasan nomor
    // antrean pun tidak keluar sampai file pertama sampai, lalu membanjir
    // sekaligus. Itulah blocking di .dl/.u/.adl: BUKAN di fase downloading
    // (tidak menyentuh outbound) dan BUKAN di sync Drive (fire-and-forget
    // sesudah kirim) — melainkan di fase sending/upload yang menahan slot
    // outbound. Perintah berikutnya sendiri tetap diproses pipeline secara
    // bersamaan, tapi balasan teksnya antre di belakang upload itu — dan
    // karena plugin menahan kunci per-pengirim (users.run) sampai balasannya
    // terkirim, perintah-perintah sesudahnya ikut menumpuk lalu meledak
    // sekaligus begitu upload selesai.
    this.queue = new WorkQueue({ concurrency: 2, maxPending }); this.lastChat = new TTLCache({ max: 5000, ttl: 3600000, now }); this.sent = []; Object.assign(this, { perChatMs, perSecond, jitter, now, wait, random })
  }
  run(chat, fn, lane = 'text') { return this.queue.run('outbound-' + lane, async () => {
    let now = this.now(); this.sent = this.sent.filter(t => now - t < 1000)
    const spacing = this.perChatMs * (1 + this.random() * this.jitter)
    const at = Math.max((this.lastChat.get(chat) ?? -Infinity) + spacing, this.sent.length >= this.perSecond ? this.sent[0] + 1000 : 0)
    if (at > now) await this.wait(at - now)
    now = this.now(); this.lastChat.set(chat, now); this.sent = this.sent.filter(t => now - t < 1000); this.sent.push(now)
    return fn()
  }) }
  close() { return this.queue.close() }
}
