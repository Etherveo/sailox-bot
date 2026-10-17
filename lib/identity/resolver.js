import { jidNormalizedUser, jidDecode, areJidsSameUser, isLidUser, isPnUser, isJidGroup } from '@whiskeysockets/baileys'
import { parsePhoneNumber } from 'awesome-phonenumber'
import { TTLCache } from '../helpers/cache.js'
import { messageState } from '../helpers/messageState.js'
import { validateTarget } from './validator.js'

export function normalize(id) {
  if (typeof id !== 'string' || !id || !jidDecode(id)?.user || !jidDecode(id)?.server) return null
  return jidNormalizedUser(id)
}
export function kind(id) {
  const n = normalize(id)
  if (!n) return 'unknown'
  if (isLidUser(n)) return 'lid'
  if (isPnUser(n)) return 'pn'
  if (isJidGroup(n)) return 'group'
  if (jidDecode(n)?.server === 'broadcast') return 'broadcast'
  if (jidDecode(n)?.server === 'newsletter') return 'newsletter'
  return 'unknown'
}
export function phoneDigits(text, countryCode = global.countryCode ?? '62') {
  if (typeof text !== 'string' || text.length > 100) return null
  let digit = text.replace(/\D/g, '')
  if (digit.startsWith('0')) digit = countryCode + digit.slice(1)
  return /^\d{7,15}$/.test(digit) && parsePhoneNumber('+' + digit).valid ? digit : null
}
export function createIdentity({ conn, db = global.db, options = global.identity ?? {}, roles = globalThis } = {}) {
  const pnToLid = new TTLCache({ max: 20000, ttl: 86400000 }), lidToPn = new TTLCache({ max: 20000, ttl: 86400000 })
  let peers = []
  const api = {
    normalize, kind,
    get self() { return [normalize(conn.user?.lid), normalize(conn.user?.id)].filter(Boolean) },
    setPeers(ids) { peers = ids.slice(0, 100).map(normalize).filter(Boolean) },
    same(a, b) {
      a = normalize(a); b = normalize(b); if (!a || !b) return false
      if (jidDecode(a).server === jidDecode(b).server && areJidsSameUser(a, b)) return true
      const ca = isPnUser(a) ? pnToLid.get(a) : a, cb = isPnUser(b) ? pnToLid.get(b) : b
      return !!ca && !!cb && jidDecode(ca)?.server === jidDecode(cb)?.server && areJidsSameUser(ca, cb)
    },
    cachedJid(id) { const n = normalize(id); return kind(n) === 'pn' ? n : lidToPn.get(n) ?? null },
    cachedLid(id) { const n = normalize(id); return kind(n) === 'lid' ? n : pnToLid.get(n) ?? null },
    learn({ lid, jid, pn, name }) {
      lid = normalize(lid); jid = normalize(jid ?? pn)
      if (kind(lid) !== 'lid' || kind(jid) !== 'pn') return false
      const oldLid = pnToLid.get(jid), oldJid = lidToPn.get(lid)
      if ((oldLid && !api.same(oldLid, lid)) || (oldJid && !areJidsSameUser(oldJid, jid))) throw new Error('Konflik pemetaan identitas')
      pnToLid.set(jid, lid); lidToPn.set(lid, jid)
      if (db) {
        const old = db.data.users[jid], current = db.data.users[lid]
        if (old && options.aliasMigration !== false) {
          const merged = { ...old, ...current, lid, jid }
          for (const k of ['banned', 'registered']) merged[k] = !!old[k] || !!current?.[k]
          for (const k of ['exp', 'level', 'warn', 'banExpires']) merged[k] = Math.max(Number(old[k]) || 0, Number(current?.[k]) || 0)
          merged.limit = current ? Math.min(old.limit, current.limit) : old.limit
          db.data.users[lid] = merged; delete db.data.users[jid]
          if (db.data.chats[jid]) { db.data.chats[lid] = { ...db.data.chats[jid], ...db.data.chats[lid] }; delete db.data.chats[jid] }
          for (const chat of Object.values(db.data.chats)) if (chat.users?.[jid]) { chat.users[lid] = { ...chat.users[jid], ...chat.users[lid] }; delete chat.users[jid] }
        }
        // Learn mappings for existing users only; the pipeline owns user creation.
        if (db.data.users[lid]) db.ensure('users', lid, { lid, jid, name })
      }
      return true
    },
    learnContext(ctx = {}) {
      const m = ctx.m; const raw = m?.key ?? ctx.key
      if (raw) {
        for (const [a, b] of [[raw.participant, raw.participantAlt], [raw.remoteJid, raw.remoteJidAlt]]) {
          if (kind(a) === 'lid' && kind(b) === 'pn') api.learn({ lid: a, jid: b })
          if (kind(b) === 'lid' && kind(a) === 'pn') api.learn({ lid: b, jid: a })
        }
      }
      const participants = ctx.participants ?? ctx.groupMetadata?.participants ?? []
      for (const p of [...participants, ...(conn.user ? [{ id: conn.user.id, lid: conn.user.lid }] : [])]) {
        const lid = [p.id, p.lid].find(x => kind(x) === 'lid'), jid = [p.id, p.phoneNumber].find(x => kind(x) === 'pn')
        if (lid && jid) api.learn({ lid, jid })
      }
    },
    async toLid(input, ctx = {}) {
      api.learnContext(ctx); const n = normalize(input)
      if (kind(n) === 'lid') return n
      if (kind(n) !== 'pn') return null
      let lid = pnToLid.get(n)
      if (!lid) { lid = await conn.signalRepository?.lidMapping?.getLIDForPN(n); if (lid) api.learn({ lid, jid: n }) }
      return normalize(lid)
    },
    async toJid(input, ctx = {}) {
      api.learnContext(ctx); const n = normalize(input)
      if (kind(n) === 'pn' || kind(n) === 'group') return n
      if (kind(n) !== 'lid') return null
      let jid = lidToPn.get(n)
      if (!jid) { jid = await conn.signalRepository?.lidMapping?.getPNForLID(n); if (jid) api.learn({ lid: n, jid }) }
      return normalize(jid)
    },
    async resolve(input, ctx = {}) {
      api.learnContext(ctx)
      let target = ctx.m?.quoted?.sender ?? ctx.m?.mentionedJid?.[0] ?? input
      if (typeof target !== 'string') return null
      if (!normalize(target)) {
        if (target.startsWith('@')) {
          const lid = target.slice(1) + '@lid'
          if (kind(lid) === 'lid' && (lidToPn.get(lid) || db?.data.users[lid] || (ctx.participants ?? []).some(p => [p.id, p.lid].some(i => api.same(i, lid))))) target = lid
        }
        if (!normalize(target)) { const digits = phoneDigits(target); if (!digits) return null; target = digits + '@s.whatsapp.net' }
      }
      if (!['pn', 'lid'].includes(kind(target))) return null
      let lid = await api.toLid(target, ctx), jid = await api.toJid(target, ctx)
      if ((!lid || !jid) && options.validate !== false) {
        const v = validateTarget(target, { db, same: api.same })
        if (v.ok) { api.learn(v); lid = v.lid; jid = v.jid }
      }
      return { lid, jid, source: lid ? 'verified' : 'typed-unverified' }
    },
    async prime(m) {
      const metadata = m.isGroup ? await conn.store?.getGroupMetadata(m.key.remoteJid) : null
      const ctx = { m, groupMetadata: metadata }; api.learnContext(ctx)
      const rawSender = m.key.fromMe ? conn.user?.lid || conn.user?.id : m.key.participant || m.key.remoteJid
      const s = messageState(m)
      s.sender = await api.toLid(rawSender, ctx) || normalize(rawSender); s.senderJid = await api.toJid(rawSender, ctx); s.senderUnresolved = kind(s.sender) !== 'lid'
      s.chat = m.isGroup ? normalize(m.key.remoteJid) : await api.toLid(m.key.remoteJid, ctx) || normalize(m.key.remoteJid)
      s.mentionedJid = await Promise.all(m.mentionedJid.slice(0, 20).map(async id => await api.toLid(id, ctx) || normalize(id)))
      const q = m.quoted
      if (q) { const qs = messageState(q); qs.sender = await api.toLid(q.key.participant || q.key.remoteJid, ctx) || normalize(q.key.participant || q.key.remoteJid); qs.senderJid = await api.toJid(qs.sender, ctx) }
      return m
    },
    isBot(id) { return [...api.self, ...peers].some(p => api.same(p, id)) },
    roleOf(id, { fromMe = false, role = conn.role ?? 'main' } = {}) {
      const has = entries => (entries ?? []).some(([pn, lid]) => api.same(id, lid ? lid + '@lid' : null) || api.same(id, pn ? pn + '@s.whatsapp.net' : null))
      const isFounder = (role === 'main' && fromMe) || has(roles.founder)
      const isOwner = isFounder || fromMe || has(roles.owner)
      return { isFounder, isOwner, isMods: isOwner || has(roles.mods) }
    },
    async forAction(ids, action, ctx = {}) {
      if (!Array.isArray(ids) || ids.length > 20) throw new Error('Maksimal 20 target')
      const out = []
      for (const id of ids) {
        const lid = await api.toLid(id, ctx), jid = await api.toJid(id, ctx)
        let value
        if (action === 'mention') {
          const form = options.mentionForm === 'auto' ? (ctx.groupMetadata?.addressingMode === 'lid' ? 'lid' : 'pn') : options.mentionForm
          value = form === 'lid' ? lid || jid : jid || lid
        } else { value = jid; if (!value) throw 'Nomor target belum diketahui; aksi dibatalkan.' }
        if (value && !out.some(x => api.same(x, value))) out.push(value)
      }
      return out
    },
  }
  return api
}
