import { TTLCache } from './helpers/cache.js'
import { WorkQueue } from './helpers/queue.js'
import { areJidsSameUser, jidDecode } from '@whiskeysockets/baileys'
import { normalize, kind } from './identity/resolver.js'
import { setTimeout as delay } from 'node:timers/promises'
import { printError } from './print.js'
export function createStore({ maxMessages = 5000, messageTTL = 21600000, maxGroups = 500, groupTTL = 900000, now = Date.now, wait = delay } = {}) {
  const messages = new TTLCache({ max: maxMessages, ttl: messageTTL, now }), groups = new TTLCache({ max: maxGroups, ttl: groupTTL, now }), names = new TTLCache({ max: 10000, ttl: 86400000, now }), inflight = new Map(), bindings = new Map(), fetchQueue = new WorkQueue({ concurrency: 1 })
  let conn, lastFetch = -Infinity
  const api = {
    names,
    bind(socket) {
      conn = socket
      const listeners = {
        'messages.upsert': ({ messages: batch }) => api.push(batch),
        'groups.upsert': updates => updates.forEach(m => groups.set(normalize(m.id), m)),
        'groups.update': updates => updates.forEach(api.updateGroup),
        'group-participants.update': update => api.updateParticipants(update),
        'contacts.upsert': contacts => api.updateContacts(contacts),
        'contacts.update': contacts => api.updateContacts(contacts),
      }
      for (const [e, fn] of Object.entries(listeners)) socket.ev.on(e, fn)
      const unbind = () => { for (const [e, fn] of Object.entries(listeners)) socket.ev.off(e, fn); bindings.delete(socket) }
      bindings.set(socket, unbind); return unbind
    },
    push(batch) { for (const m of Array.isArray(batch) ? batch : [batch]) if (m?.key?.id && ['pn', 'lid', 'group'].includes(kind(m.key.remoteJid))) { messages.set(m.key.id, m); if (m.pushName) names.set(conn?.identity?.cachedLid(m.sender || m.key.participant || m.key.remoteJid) || normalize(m.sender || m.key.participant || m.key.remoteJid), m.pushName) } },
    getMessage(key) { const m = messages.get(key.id); return m && (!key.remoteJid || jidDecode(m.key.remoteJid)?.server === jidDecode(key.remoteJid)?.server && areJidsSameUser(normalize(m.key.remoteJid), normalize(key.remoteJid))) ? m.message : undefined },
    loadMessage(id) { return messages.get(id) },
    markRevoked(id) { const m = messages.get(id); if (m) Object.defineProperty(m, 'revoked', { value: true, configurable: true }) },
    cachedGroupMetadata(jid) { return groups.get(normalize(jid)) },
    getGroupMetadata(jid) {
      jid = normalize(jid); const cached = groups.get(jid); if (cached) return Promise.resolve(cached)
      if (inflight.has(jid)) return inflight.get(jid)
      const promise = fetchQueue.run(jid, async () => { const gap = 1000 - (now() - lastFetch); if (gap > 0) await wait(gap); lastFetch = now(); const m = await conn.groupMetadata(jid); groups.set(jid, m); return m }).finally(() => inflight.delete(jid))
      inflight.set(jid, promise); return promise
    },
    updateGroup(update) { const id = normalize(update.id), old = groups.get(id); if (old) groups.set(id, { ...old, ...update }); else groups.del(id) },
    updateParticipants({ id, participants, action }) {
      const key = normalize(id), old = groups.get(key)
      // Invalidating prevents stale permissions and handles PN/LID deltas conservatively.
      groups.del(key)
      if (old && conn) api.getGroupMetadata(key).catch(e => printError(e, { event: 'group-cache' }))
    },
    updateContacts(contacts) { for (const c of contacts) if (c.id && (c.name || c.notify || c.verifiedName)) names.set(normalize(c.lid || c.id), c.name || c.notify || c.verifiedName) },
    get size() { return messages.size },
    async close() { for (const unbind of [...bindings.values()]) unbind(); await fetchQueue.close(); messages.close(); groups.close(); names.close() },
  }
  return api
}
