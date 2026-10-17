import { EventEmitter } from 'node:events'
import { useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers, DisconnectReason, proto } from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import { makeWASocket } from '../simple.js'
import { createIdentity, phoneDigits, kind } from '../identity/resolver.js'
import { TTLCache } from '../helpers/cache.js'
import { OutboundQueue } from '../helpers/queue.js'
import { KeyedLock } from '../helpers/lock.js'
import { silentLogger } from '../helpers/silentLogger.js'
import { prompt } from '../helpers/prompt.js'
import { rememberSecret } from '../helpers/redact.js'
import { logger, printError, showLogin } from '../print.js'
export function disconnectPolicy(code, { badSessions = 0, failures = 0, random = Math.random } = {}) {
  if (code === DisconnectReason.loggedOut) return { terminal: 'logged_out' }
  if (code === DisconnectReason.connectionReplaced) return { terminal: 'replaced' }
  if ([DisconnectReason.forbidden, DisconnectReason.multideviceMismatch].includes(code)) return { terminal: 'fatal' }
  if (code === DisconnectReason.badSession && badSessions >= 1) return { terminal: 'fatal' }
  if (failures >= 30) return { terminal: 'fatal' }
  if (code === DisconnectReason.restartRequired) return { delay: 0 }
  return { delay: Math.round(Math.min(60000, 1000 * 2 ** Math.min(failures, 16)) * (0.8 + random() * 0.4)) }
}
export function createConnection({ role = 'main', authDir, phoneNumber, pairingCode, loginMethod, handlers = {}, store, db = global.db, onStatus = () => {}, onSocket = () => {}, onQR = async qr => showLogin('\x1b[2J\x1b[HWhatsApp → Perangkat tertaut → Tautkan perangkat → pindai kode.\n' + await QRCode.toString(qr, { type: 'terminal', small: true })), onPairingCode = code => showLogin(`Kode pairing: ${code.match(/.{1,4}/g).join('-')}\nWhatsApp → Perangkat tertaut → Tautkan perangkat → Tautkan dengan nomor telepon.`), deps = {}, outbound = new OutboundQueue() } = {}) {
  const events = new EventEmitter(), lifecycle = new KeyedLock(), credsWriter = new KeyedLock(), retryCache = new TTLCache({ max: 5000, ttl: 3600000 })
  const schedule = deps.setTimeout ?? setTimeout, cancel = deps.clearTimeout ?? clearTimeout
  let sock = null, auth, unbind, listeners = [], reconnectTimer, stableTimer, stopped = true, state = 'idle', failures = 0, badSessions = 0, method, number, startPromise, generation = 0
  const identity = createIdentity({ conn: { get user() { return sock?.user }, get signalRepository() { return sock?.signalRepository }, get store() { return store }, role }, db })
  const setState = (next, extra = {}) => { state = next; onStatus({ state: next, ...extra }); events.emit('status', { state: next, ...extra }) }
  const safe = fn => (...args) => Promise.resolve().then(() => fn(...args)).catch(e => { printError(e, { module: 'connection' }); events.emit('failure', e) })
  async function dispose() {
    cancel(stableTimer); stableTimer = undefined; unbind?.(); unbind = null
    if (sock) { for (const [event, fn] of listeners) sock.ev.off(event, fn); listeners = []; sock.end?.(new Error('Koneksi ditutup oleh controller')) }
  }
  function bind(event, fn) { const wrapped = safe(fn); listeners.push([event, wrapped]); sock.ev.on(event, wrapped) }
  async function openSocket() {
    if (stopped) return
    await dispose(); await credsWriter.run('creds', async () => {})
    const epoch = ++generation; let pairingRequested = false
    const factory = deps.makeSocket ?? makeWASocket
    sock = factory({ logger: silentLogger, auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, silentLogger) }, browser: Browsers.ubuntu('Chrome'), syncFullHistory: false, markOnlineOnConnect: global.markOnline ?? false, generateHighQualityLinkPreview: false, getMessage: key => store.getMessage(key), cachedGroupMetadata: jid => store.cachedGroupMetadata(jid), msgRetryCounterCache: retryCache, shouldIgnoreJid: jid => ['broadcast', 'newsletter'].includes(kind(jid)), keepAliveIntervalMs: 30000, connectTimeoutMs: 60000, retryRequestDelayMs: 250, maxMsgRetryCount: 5 }, { store, db, role, identity, outbound, canSend: () => state === 'open' })
    onSocket(sock); unbind = store.bind(sock); setState('connecting')
    bind('creds.update', () => credsWriter.run('creds', () => auth.saveCreds()).catch(async e => { stopped = true; setState('fatal', { reason: 'Gagal menyimpan kredensial' }); await dispose(); throw e }))
    bind('connection.update', update => lifecycle.run('connection', async () => {
      if (stopped || epoch !== generation) return
      if (update.qr && !auth.state.creds.registered) {
        if (method === 'qr') await onQR(update.qr)
        else if (!pairingRequested) { pairingRequested = true; const code = await sock.requestPairingCode(number, role === 'main' && /^[A-Za-z0-9]{8}$/.test(pairingCode ?? global.pairing ?? '') ? pairingCode ?? global.pairing : undefined); rememberSecret(code); await onPairingCode(code); events.emit('pairing', { code }) }
      }
      if (update.connection === 'open') { if (sock.user && !sock.user.jid) Object.defineProperty(sock.user, 'jid', { value: identity.normalize(sock.user.id), configurable: true }); setState('open', { me: sock.user }); cancel(stableTimer); stableTimer = schedule(() => { failures = 0; badSessions = 0 }, 60000); stableTimer?.unref?.(); return }
      if (update.connection !== 'close') return
      const code = update.lastDisconnect?.error?.output?.statusCode
      const policy = disconnectPolicy(code, { badSessions, failures, random: deps.random ?? Math.random })
      if (code === DisconnectReason.badSession) badSessions++
      await dispose()
      if (policy.terminal) { stopped = true; setState(policy.terminal, { reason: `Koneksi berhenti (kode ${code ?? 'unknown'}). ${policy.terminal === 'logged_out' ? 'Sesi dipertahankan; penautan ulang harus dilakukan operator.' : policy.terminal === 'replaced' ? 'Ada instance lain memakai sesi ini.' : 'Periksa status akun dan sesi.'}` }); return }
      if (code !== DisconnectReason.restartRequired) failures++
      setState('backoff', { code, delay: policy.delay })
      reconnectTimer = schedule(() => { reconnectTimer = undefined; lifecycle.run('connection', openSocket).catch(e => { printError(e); stopped = true; setState('fatal') }) }, policy.delay)
    }))
    bind('messages.upsert', update => {
      for (const m of update.messages ?? []) if (m.messageStubType === proto.WebMessageInfo.StubType.GROUP_CHANGE_ICON || m.messageStubType === proto.WebMessageInfo.StubType.GROUP_CHANGE_INVITE_LINK) safe(() => handlers.groupsUpdate?.call(sock, [{ id: m.key.remoteJid, actor: m.key.participant, ...(m.messageStubType === proto.WebMessageInfo.StubType.GROUP_CHANGE_ICON ? { icon: true } : { revoke: true }) }]))()
      if (update.type === 'notify') return handlers.handler?.call(sock, update)
    })
    bind('messages.update', async updates => { for (const { key, update } of updates) if (update.messageStubType === proto.WebMessageInfo.StubType.REVOKE) { await handlers.deleteUpdate?.call(sock, { id: key.id, chat: key.remoteJid, key, update, revokerIsBot: !!update.key?.fromMe || identity.isBot(update.key?.participant) }); store.markRevoked(key.id) } })
    bind('groups.update', updates => handlers.groupsUpdate?.call(sock, updates))
    bind('group-participants.update', update => handlers.participantsUpdate?.call(sock, update))
    bind('lid-mapping.update', mapping => identity.learn(mapping))
  }
  const controller = {
    get sock() { return sock }, get state() { return state }, identity,
    on(event, fn) { events.on(event, fn); return controller },
    start() {
      if (!stopped) return startPromise ?? Promise.resolve()
      stopped = false
      startPromise = (async () => {
        auth = await (deps.auth ?? useMultiFileAuthState)(authDir)
        if (!auth.state.creds.registered) {
          const choice = role === 'main' ? loginMethod ?? process.env.BOT_LOGIN_METHOD ?? await prompt('Pilih metode login: [1] Pairing code (default), [2] QR code:') : 'pairing'
          method = ['2', 'qr'].includes(choice) ? 'qr' : 'pairing'
          if (method === 'pairing') { const input = phoneNumber || (role === 'main' ? global.nomorbot || await prompt('Nomor WhatsApp bot (format internasional):') : null); number = phoneDigits(input); if (!number) throw new Error('Nomor bot tidak valid') }
        }
        await lifecycle.run('connection', openSocket)
      })().catch(e => { stopped = true; setState('fatal'); throw e })
      return startPromise
    },
    async stop({ logout = false } = {}) { stopped = true; generation++; cancel(reconnectTimer); cancel(stableTimer); await lifecycle.run('connection', async () => { if (logout && sock) await sock.logout(); await dispose(); await credsWriter.run('creds', async () => {}); setState('stopped') }) },
  }
  return controller
}
