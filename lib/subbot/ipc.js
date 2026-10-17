const states = new Set(['connecting', 'pairing', 'open', 'backoff', 'stopped', 'logged_out', 'replaced', 'fatal'])
const string = (x, max = 1000) => typeof x === 'string' && x.length <= max
const plain = x => x && typeof x === 'object' && !Array.isArray(x)
export function validIPC(m, direction) {
  if (!plain(m) || m.v !== 1) return false
  try { if (Buffer.byteLength(JSON.stringify(m)) > 65536) return false } catch { return false }
  if (direction === 'to-worker') {
    if (m.type === 'start') return string(m.sandbox) && /^\d{7,15}$/.test(m.number) && plain(m.owner) && string(m.owner.number, 15) && string(m.owner.lid, 100) && string(m.owner.name, 100) && plain(m.config) && (typeof m.config.prefix === 'string' || Array.isArray(m.config.prefix)) && string(m.config.timezone, 100) && /^\d{1,3}$/.test(m.config.countryCode) && Number.isFinite(m.config.defaultLimit) && ['maxPlugins', 'maxPluginKB'].every(k => Number.isInteger(m.config[k]) && m.config[k] > 0) && [false, true, 'owner-approval'].includes(m.config.allowCustomPlugins) && plain(m.config.outbound) && Number.isFinite(m.config.outbound.perChatMs) && m.config.outbound.perChatMs >= 0 && Number.isInteger(m.config.outbound.perSecond) && m.config.outbound.perSecond > 0 && plain(m.pairing) && typeof m.pairing.needed === 'boolean'
    if (m.type === 'peers') return Array.isArray(m.ids) && m.ids.length <= 100 && m.ids.every(x => string(x, 100))
    if (m.type === 'stop') return string(m.reason) && (m.logout === undefined || typeof m.logout === 'boolean')
    return m.type === 'ping'
  }
  if (m.type === 'ready') return Number.isInteger(m.pid) && m.pid > 0
  if (m.type === 'pairing-code') return /^[a-z0-9]{8}$/i.test(m.code)
  if (m.type === 'status') return states.has(m.state) && (m.me === undefined || plain(m.me)) && (m.reason === undefined || string(m.reason)) && (m.selfCheck === undefined || plain(m.selfCheck))
  if (m.type === 'heartbeat') return ['t', 'rss', 'heapUsed'].every(k => Number.isFinite(m[k]) && m[k] >= 0)
  if (m.type === 'log') return ['info', 'warn', 'error', 'debug'].includes(m.level) && string(m.line, 2000)
  if (m.type === 'fatal') return string(m.message)
  return false
}
export function sendIPC(child, type, payload = {}, direction = 'to-worker') {
  const message = { v: 1, type, ...payload }
  if (!validIPC(message, direction)) throw new Error('Pesan IPC tidak valid')
  if (!child.connected) return Promise.reject(new Error('IPC terputus'))
  return new Promise((resolve, reject) => child.send(message, e => e ? reject(e) : resolve()))
}
