import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SubBotRegistry } from './registry.js'
import { launchWorker } from './launcher.js'
import { sendIPC, validIPC } from './ipc.js'
import { sessionId, sandboxPath, scaffoldSandbox, deleteSandbox, diskUsage, assertNoSymlinks } from './sandbox.js'
import { readApproval } from './approval.js'
import { codeHash, inspectPolicy } from './policy.js'
import { scanPluginFiles, savePluginFile } from '../plugins/files.js'
import { EventEmitter } from 'node:events'
import { KeyedLock } from '../helpers/lock.js'
import { TTLCache } from '../helpers/cache.js'
import { jidDecode } from '@whiskeysockets/baileys'
import { phoneDigits } from '../identity/resolver.js'
import { logger, printError, redact } from '../print.js'
export class SubBotManager {
  constructor({ root, db, getConn, config = global.bots, spawn = launchWorker, now = Date.now, notify, timers = globalThis }) {
    Object.assign(this, { root, db, getConn, config, spawn, now, timers }); this.botsRoot = path.join(root, 'bots'); this.registry = new SubBotRegistry(db); this.workers = new Map(); this.lock = new KeyedLock(); this.attempts = new TTLCache({ max: 10000, ttl: 3600000, now }); this.numberAttempts = new TTLCache({ max: 10000, ttl: 300000, now }); this.stopping = false
    this.notify = notify ?? (async (record, text) => { const conn = getConn(); if (conn && record.ownerJid) await conn.reply(record.ownerJid, text) })
    this.watchdog = timers.setInterval(() => this.inspectWorkers().catch(printError), 10000); this.watchdog.unref?.()
  }
  async create(number, owner, { isOwner = false } = {}) {
    return this.lock.run('create', async () => {
      if (this.stopping || !this.config.enabled) throw 'Jadibot belum diaktifkan operator.'
      const conn = this.getConn(), botKey = conn.identity.self.find(x => conn.identity.kind(x) === 'lid') || conn.identity.self[0]
      if (!this.db.ensure('settings', botKey).jadibot) throw 'Jadibot belum diaktifkan pada bot utama.'
      number = phoneDigits(number); if (!number) throw 'Nomor WhatsApp tidak valid.'
      if (!owner.jid || (!isOwner && !conn.identity.same(owner.jid, number + '@s.whatsapp.net'))) throw 'Nomor jadibot harus milik pengirim yang terverifikasi.'
      if (conn.identity.self.some(id => conn.identity.same(id, number + '@s.whatsapp.net'))) throw 'Nomor bot utama tidak boleh dipakai.'
      const id = sessionId(number), existing = this.registry.get(id)
      if (existing && !conn.identity.same(existing.ownerLid || existing.ownerJid, owner.lid || owner.jid) && !isOwner) throw 'Sesi ini dimiliki user lain.'
      if (existing && ['pairing', 'starting', 'active'].includes(existing.status)) throw 'Sub-bot sudah berjalan.'
      if (!existing && this.registry.list().length >= this.config.maxBots) throw 'Kapasitas sub-bot penuh.'
      if (!existing && this.registry.list().filter(r => conn.identity.same(r.ownerLid || r.ownerJid, owner.lid || owner.jid)).length >= this.config.maxPerUser) throw 'Kuota sub-bot per user habis.'
      const userKey = owner.lid || owner.jid, attempt = this.attempts.get(userKey) ?? { count: 0, until: this.now() + 3600000 }
      if (attempt.count >= 3 || this.numberAttempts.get(number)) throw 'Batas percobaan pairing tercapai. Coba lagi nanti.'
      attempt.count++; this.attempts.set(userKey, attempt, attempt.until - this.now()); this.numberAttempts.set(number, true)
      const dir = await scaffoldSandbox(this.botsRoot, id, path.join(this.root, 'lib/subbot/templates/plugins'))
      // Never adopt an unregistered pre-existing session as a different user's bot.
      if (!existing) { try { await fs.access(path.join(dir, 'auth/creds.json')); throw new Error('Sandbox berisi sesi tanpa registry; perlu pemeriksaan operator') } catch (e) { if (e.code !== 'ENOENT') throw e } }
      await this.registry.set(id, { id, number, ownerLid: owner.lid || '', ownerJid: owner.jid, ownerName: owner.name || '', status: 'pairing', createdAt: existing?.createdAt || this.now(), policy: existing?.policy || { allowCustomPlugins: this.config.allowCustomPlugins, approved: [] } })
      await this.launch(id); return id
    })
  }
  launch(id) { return this.lock.run('worker:' + id, () => this._launch(id)) }
  async _launch(id) {
    if (this.workers.has(id) || this.stopping) return
    const r = this.registry.get(id); if (!r) throw new Error('Registry sub-bot tidak ada')
    const sandbox = await sandboxPath(this.botsRoot, id); await assertNoSymlinks(sandbox)
    let everRegistered = false
    try { everRegistered = JSON.parse(await fs.readFile(path.join(sandbox, 'auth/creds.json'), 'utf8')).registered === true } catch (e) { if (e.code !== 'ENOENT') throw new Error('Kredensial sub-bot tidak dapat dibaca', { cause: e }) }
    await this.registry.set(id, { status: 'starting', startedAt: this.now() })
    const spawnResult = this.spawn({ root: this.root, sandbox, id, config: { ...this.config, timezone: global.timezone } })
    const w = { child: spawnResult.child, status: 'starting', lastHeartbeat: this.now(), anomalies: 0, intentional: false, pairingTimer: null, readyTimer: null, restartTimer: null, everRegistered, handling: new KeyedLock(), statusEvents: new EventEmitter(), permission: spawnResult.permission, allowCustomPlugins: spawnResult.allowCustomPlugins }
    this.workers.set(id, w)
    w.readyTimer = this.timers.setTimeout(() => { w.failure = 'Worker tidak ready dalam 15 detik'; w.child.kill() }, 15000)
    w.child.on('message', msg => { if (validIPC(msg, 'from-worker') && msg.type === 'status' && msg.state === 'stopped' && msg.reason === 'logout-complete') w.logoutAcknowledged = true; w.handling.run('ipc', async () => {
      if (!validIPC(msg, 'from-worker')) { if (++w.anomalies >= 5) { w.failure = 'Anomali IPC berulang'; w.child.kill() } return }
      if (msg.type === 'ready') {
        if (w.ready) return; w.ready = true; this.timers.clearTimeout(w.readyTimer)
        const templates = path.join(this.root, 'lib/subbot/templates/plugins'), templateHashes = []
        for (const f of await scanPluginFiles(templates)) templateHashes.push(codeHash(await fs.readFile(path.join(templates, f), 'utf8')))
        const allowed = w.permission && this.config.allowCustomPlugins !== false ? r.policy.allowCustomPlugins : false
        if (!w.permission) logger.warn('Permission Model tidak tersedia; plugin kustom sub-bot dimatikan.')
        await sendIPC(w.child, 'start', { sandbox, number: r.number, owner: { number: jidUser(r.ownerJid), lid: jidUser(r.ownerLid), name: r.ownerName ?? '' }, config: { prefix: serializePrefix(global.prefix), timezone: global.timezone, countryCode: global.countryCode, defaultLimit: global.defaultLimit, maxPlugins: this.config.maxPlugins, maxPluginKB: this.config.maxPluginKB, allowCustomPlugins: allowed, outbound: this.config.outbound, logRelay: 'masked', allowedPackages: this.config.allowedPackages, approved: r.policy.approved, templateHashes }, pairing: { needed: !w.everRegistered } })
        if (!w.everRegistered) w.pairingTimer = this.timers.setTimeout(() => this.failPairing(id).catch(printError), this.config.pairingTimeoutSec * 1000)
        await this.publishPeers()
      } else if (msg.type === 'heartbeat') { w.lastHeartbeat = this.now(); w.rss = msg.rss; w.heapUsed = msg.heapUsed }
      else if (msg.type === 'pairing-code') { await this.notify(r, `Kode pairing: ${msg.code.match(/.{1,4}/g).join('-')}\nWhatsApp → Perangkat tertaut → Tautkan perangkat → Tautkan dengan nomor telepon.\nBatas waktu ${this.config.pairingTimeoutSec} detik. Akun dipakai sebagai bot dan berisiko dibatasi/ban. Jangan bagikan kode ini.`) }
      else if (msg.type === 'status') {
        if (msg.selfCheck && (!msg.selfCheck.configDenied || !msg.selfCheck.envMinimal)) { w.allowCustomPlugins = false; await this.registry.set(id, { policy: { ...r.policy, allowCustomPlugins: false } }); logger.warn('Self-check sub-bot gagal; plugin kustom dinonaktifkan.'); if (msg.selfCheck.customEnabled) { w.failure = 'Self-check gagal'; w.child.kill(); return } }
        w.status = msg.state; w.statusEvents.emit('status', msg.state)
        if (msg.state === 'open') { this.timers.clearTimeout(w.pairingTimer); w.everRegistered = true; await this.registry.set(id, { status: 'active', botLid: msg.me?.lid ?? '', botJid: msg.me?.id ?? '', lastActiveAt: this.now(), lastError: '' }); await this.publishPeers(); if (!w.notifiedOpen) { w.notifiedOpen = true; await this.notify(r, 'Sub-bot aktif. Command dasar: .menu, .ping, .getlid. Gunakan .stopjadibot pada bot utama untuk berhenti.') } }
        else if (msg.state === 'logged_out') { w.intentional = true; await this.stop(id, { status: 'logged_out' }); const auth = await sandboxPath(sandbox, 'auth'); await assertNoSymlinks(auth); await fs.rm(auth, { force: true, recursive: true }); await fs.mkdir(auth, { mode: 0o700 }); await this.notify(r, 'Sub-bot logout. Jalankan jadibot lagi untuk menautkan ulang.') }
        else if (['replaced', 'fatal'].includes(msg.state)) { w.intentional = true; await this.stop(id, { status: msg.state === 'replaced' ? 'stopped' : 'failed' }); await this.notify(r, 'Sub-bot berhenti. Periksa perangkat tertaut/status akun.') }
      } else if (msg.type === 'fatal') { w.failure = redact(msg.message); w.child.kill() }
      else if (msg.type === 'log' && this.allowLog(w)) logger.info('[sub] ' + msg.level + ': laporan worker (isi disamarkan)')
    }).catch(e => { printError(e, { module: 'subbot-ipc' }); w.failure = 'Gagal memproses IPC'; w.child.kill() }) })
    const relay = () => { if (this.allowLog(w)) logger.warn('[sub] Worker mengeluarkan output; isi disamarkan.') }
    w.child.stdout?.on('data', relay); w.child.stderr?.on('data', relay)
    w.child.on('error', e => { w.failure = redact(e.message); printError(e, { module: 'worker' }) })
    w.child.once('exit', () => this.onExit(id, w).catch(printError))
  }
  allowLog(w) { const sec = Math.floor(this.now() / 1000); if (w.logSec !== sec) { w.logSec = sec; w.logLines = 0 } return ++w.logLines <= 20 }
  async onExit(id, w) {
    this.timers.clearTimeout(w.readyTimer); this.timers.clearTimeout(w.pairingTimer)
    if (this.workers.get(id) === w) this.workers.delete(id)
    await this.publishPeers()
    const r = this.registry.get(id)
    if (!r || w.intentional || this.stopping) return
    const window = this.now() - r.restarts.windowStart < 3600000 ? r.restarts : { count: 0, windowStart: this.now() }
    window.count++
    await this.registry.set(id, { status: window.count > 5 ? 'failed' : 'starting', restarts: window, lastError: w.failure || 'Worker keluar tak terduga' })
    if (window.count > 5) { await this.notify(r, 'Sub-bot gagal setelah lebih dari 5 restart per jam. Hubungi operator.'); return }
    const ms = Math.min(300000, 5000 * 2 ** (window.count - 1))
    const timer = this.timers.setTimeout(() => { this.restartTimers.delete(id); this.launch(id).catch(printError) }, ms); this.restartTimers.set(id, timer)
  }
  restartTimers = new Map()
  async failPairing(id) {
    const w = this.workers.get(id); if (!w || w.status === 'open') return
    const r = this.registry.get(id); await this.stop(id, { status: 'failed' })
    let registered = w.everRegistered
    try { registered ||= JSON.parse(await fs.readFile(await sandboxPath(this.botsRoot, id + '/auth/creds.json'), 'utf8')).registered === true } catch (e) { if (e.code !== 'ENOENT') { registered = true; printError(e, { module: 'pairing-timeout' }) } }
    if (!registered) await deleteSandbox(this.botsRoot, id)
    await this.notify(r, 'Pairing melewati batas waktu. Jalankan jadibot lagi.')
  }
  stop(id, options = {}) { return this.lock.run('worker:' + id, () => this._stop(id, options)) }
  async _stop(id, { logout = false, status = 'stopped' } = {}) {
    const r = this.registry.get(id); if (!r) throw 'Sub-bot tidak ditemukan.'
    this.timers.clearTimeout(this.restartTimers.get(id)); this.restartTimers.delete(id)
    const w = this.workers.get(id)
    if (w) {
      w.intentional = true; this.timers.clearTimeout(w.readyTimer); this.timers.clearTimeout(w.pairingTimer)
      await new Promise(resolve => {
        let finished = false; const finish = () => { if (finished) return; finished = true; this.timers.clearTimeout(timeout); resolve() }
        const timeout = this.timers.setTimeout(() => { w.child.kill('SIGKILL') }, 10000)
        w.child.once('exit', finish)
        sendIPC(w.child, 'stop', { reason: logout ? 'delete' : 'stop', logout }).catch(() => w.child.kill('SIGTERM'))
        if (w.child.exitCode != null || w.child.signalCode) finish()
      })
      this.workers.delete(id)
      if (logout && w.everRegistered && !w.logoutAcknowledged) { await this.registry.set(id, { status: 'stopped', lastError: 'Logout belum terkonfirmasi; sandbox dipertahankan' }); throw 'Logout belum terkonfirmasi. Sesi dan data dipertahankan; coba lagi setelah koneksi terbuka.' }
    }
    await this.registry.set(id, { status, stoppedAt: this.now() }); await this.publishPeers()
  }
  async waitUntilOpen(id, timeoutMs = 60000) {
    const w = this.workers.get(id)
    if (!w) throw 'Worker tidak berjalan.'
    if (w.status === 'open') return
    await new Promise((resolve, reject) => {
      const finish = error => { this.timers.clearTimeout(timer); w.statusEvents.off('status', onStatus); w.child.off('exit', onExit); error ? reject(error) : resolve() }
      const onStatus = state => { if (state === 'open') finish(); else if (['fatal', 'replaced', 'logged_out'].includes(state)) finish(new Error('Sesi tidak dapat dibuka untuk logout')) }
      const onExit = () => finish(new Error('Worker berhenti sebelum logout'))
      const timer = this.timers.setTimeout(() => finish(new Error('Koneksi belum terbuka; data dipertahankan')), timeoutMs)
      w.statusEvents.on('status', onStatus); w.child.once('exit', onExit)
    })
  }
  async delete(id) {
    if (!this.workers.has(id)) {
      const r = this.registry.get(id); if (!r) throw 'Sub-bot tidak ditemukan.'
      const dir = await sandboxPath(this.botsRoot, id); let registered = false
      try { registered = JSON.parse(await fs.readFile(path.join(dir, 'auth/creds.json'), 'utf8')).registered === true } catch (e) { if (e.code !== 'ENOENT') throw e }
      if (registered) { await this.launch(id); await this.waitUntilOpen(id) }
    } else if (this.workers.get(id).everRegistered) await this.waitUntilOpen(id)
    await this.stop(id, { logout: true }); await deleteSandbox(this.botsRoot, id); await this.registry.delete(id)
  }
  authorize(id, sender, isOwner) { const r = this.registry.get(id); if (!r || (!isOwner && !this.getConn().identity.same(sender, r.ownerLid || r.ownerJid))) throw 'Sesi bukan milik lo atau tidak ditemukan.'; return r }
  async restoreAll() { if (!this.config.enabled) return; const conn = this.getConn(); const key = conn.identity.self.find(x => conn.identity.kind(x) === 'lid') || conn.identity.self[0]; if (!this.db.ensure('settings', key).jadibot) return; for (const r of this.registry.list().filter(r => ['active', 'starting', 'pairing'].includes(r.status)).slice(0, this.config.maxBots)) { if (this.stopping) break; while ([...this.workers.values()].filter(w => w.status === 'starting').length >= 2 && !this.stopping) await delay(1000); if (this.stopping) break; await this.launch(r.id); await delay(this.config.spawnStaggerSec * 1000) } }
  async publishPeers() { const ids = [...(this.getConn()?.identity.self ?? []), ...this.registry.list().filter(r => this.workers.get(r.id)?.status === 'open').flatMap(r => [r.botLid, r.botJid])].filter(Boolean); this.getConn()?.identity.setPeers(ids); for (const w of this.workers.values()) if (w.ready && w.child.connected) await sendIPC(w.child, 'peers', { ids }).catch(e => printError(e, { module: 'peers' })) }
  async inspectWorkers() {
    if (this.inspectRunning || this.stopping) return; this.inspectRunning = true
    try { for (const [id, w] of this.workers) { if (this.now() - w.lastHeartbeat > 60000) { w.failure = 'Heartbeat hilang 60 detik'; w.child.kill('SIGKILL'); continue } if (await diskUsage(await sandboxPath(this.botsRoot, id)) > this.config.maxDiskMB * 1024 * 1024) { w.failure = 'Kuota disk terlampaui'; await this.stop(id, { status: 'failed' }); await this.notify(this.registry.get(id), 'Sub-bot dihentikan karena kuota disk.') } } } finally { this.inspectRunning = false }
  }
  async approve(id, requestId) {
    const r = this.registry.get(id); if (!r || r.policy.allowCustomPlugins !== 'owner-approval') throw 'Sesi tidak memakai mode owner-approval.'
    const sandbox = await sandboxPath(this.botsRoot, id), request = await readApproval(sandbox, requestId, this.config.maxPluginKB)
    const result = inspectPolicy(request.code, { root: path.join(sandbox, 'plugins'), allowedPackages: this.config.allowedPackages })
    const restart = this.workers.has(id); if (restart) await this.stop(id)
    await this.registry.set(id, { policy: { ...r.policy, approved: [...new Set([...r.policy.approved, result.hash])].slice(-100) } })
    const loader = { reload: async () => ({ ok: true }), remove: async () => {}, get: () => null }
    const saved = await savePluginFile({ root: path.join(sandbox, 'plugins'), name: request.name, code: request.code, maxKB: this.config.maxPluginKB, maxPlugins: this.config.maxPlugins, loader, policy: c => inspectPolicy(c, { root: path.join(sandbox, 'plugins'), allowedPackages: this.config.allowedPackages }) })
    await fs.unlink(request.file); if (restart) await this.launch(id); return saved.id
  }
  async stopAll() { this.stopping = true; this.timers.clearInterval(this.watchdog); for (const t of this.restartTimers.values()) this.timers.clearTimeout(t); this.restartTimers.clear(); await Promise.all([...this.workers.keys()].map(id => this.stop(id, { status: ['active', 'starting', 'pairing'].includes(this.registry.get(id)?.status) ? this.registry.get(id).status : 'stopped' }))) }
}
function jidUser(jid) { return jidDecode(jid)?.user ?? '' }
function serializePrefix(prefix) { return prefix instanceof RegExp ? [{ regex: prefix.source, flags: prefix.flags }] : Array.isArray(prefix) ? prefix.map(p => p instanceof RegExp ? { regex: p.source, flags: p.flags } : p) : prefix }
