import path from 'node:path'
import { proto, jidDecode } from '@whiskeysockets/baileys'
import { smsg } from '../simple.js'
import { printMessage, printError, redact } from '../print.js'
import { WorkQueue } from '../helpers/queue.js'
import { TTLCache } from '../helpers/cache.js'
import { KeyedLock } from '../helpers/lock.js'
import { dfail, limitText, messages } from '../helpers/messages.js'
import { parseCommand, unprefixFallbackInput } from '../helpers/parsing.js'
import { permissionFailure } from '../helpers/permissions.js'
import { refreshPremium, isPremium, premiumRemainingMs, formatPremiumRemaining } from '../helpers/premium.js'
import { dayKey } from '../helpers/time.js'
import { noteGuardCommand } from '../helpers/sendGuard.js'
import { kind } from '../identity/resolver.js'
// Gagal founder: diam ke pemakai, kabari founder lewat DM saja (bukan
// owner/mods, bukan pesan penolakan di chat asal). Hanya nama command yang
// dikirim — argumen tidak ikut, supaya tidak membocorkan input pemakai.
function founderJidOf(config) {
  const entry = (config.founder ?? config.owner ?? [])[0]
  const digits = String(Array.isArray(entry) ? entry[0] : entry ?? '').replace(/\D/g, '')
  return digits ? `${digits}@s.whatsapp.net` : null
}
async function notifyFounderAttempt(conn, config, m, attempt) {
  const founderJid = founderJidOf(config)
  if (!founderJid) return false
  const who = [m.pushName, m.senderJid ?? m.sender].filter(Boolean).join(' ')
  const chatLabel = m.isGroup ? `${attempt.chatName ?? m.chat} (${m.chat})` : `DM (${m.chat})`
  const text = [
    '🔒 Percobaan command khusus founder',
    `👤 Pengirim: ${String(who).slice(0, 200)}`,
    `💬 Command: ${String(attempt.command).slice(0, 100)}`,
    `💭 Chat: ${String(chatLabel).slice(0, 200)}`,
  ].join('\n')
  await conn.reply(founderJid, text)
  return true
}
export function createPipeline({ db, plugins, config = globalThis, now = Date.now, root = process.cwd(), log = printMessage, error = printError } = {}) {
  const queue = new WorkQueue({ concurrency: 8 }), users = new KeyedLock(), dedupe = new TTLCache({ max: 2000, ttl: 21600000, now }), cooldown = new TTLCache({ max: 10000, ttl: 3600000, now }), reports = new TTLCache({ max: 1000, ttl: 60000, now }), eventRates = new TTLCache({ max: 2000, ttl: 60000, now })
  function botKey(conn) { return conn.identity.self.find(id => kind(id) === 'lid') || conn.identity.self[0] }
  const list = () => plugins.list().filter(({ plugin }) => !plugin.disabled)
  const cfg = conn => db.ensure('settings', botKey(conn))
  async function hook(fn, conn, m, ctx, id) { try { return await fn.call(conn, m, ctx) } catch (e) { error(e, { plugin: id, stage: 'hook' }) } }
  async function processOne(conn, raw, chatUpdate) {
    if (!raw?.message || raw.messageStubType || !['pn', 'lid', 'group'].includes(kind(raw.key?.remoteJid))) return
    const timestamp = Number(raw.messageTimestamp?.toString?.() ?? raw.messageTimestamp ?? 0)
    if (!timestamp || now() / 1000 - timestamp > (config.maxMessageAgeSec ?? 120) || timestamp * 1000 > now() + 60000) return
    const m = smsg(conn, raw)
    if (['protocolMessage', 'senderKeyDistributionMessage'].includes(m.mtype) || !m.mtype || m.text.length > 10000 || m.mentionedJid.length > 20 || (m.text.match(/https?:\/\//gi)?.length ?? 0) > 5) return
    await conn.identity.prime(m)
    const key = `${m.key.remoteJid}:${m.key.participant ?? ''}:${m.key.id}:${m.fromMe}`
    if (dedupe.get(key)) return; dedupe.set(key, true); conn.store.push([m])
    if (m.isBaileys) return
    // Nama user TIDAK diisi dari pushName: record baru default namanya
    // string kosong (lihat lib/database/collections/users.js), supaya
    // .profile jatuh ke fallback 'Unknown' sampai user .register —
    // .register yang mengisi nama (menimpa nama lama bila ada).
    const u = db.ensure('users', m.sender, { lid: kind(m.sender) === 'lid' ? m.sender : '', jid: m.senderJid }), chat = db.ensure('chats', m.chat), settings = cfg(conn)
    const roles = conn.identity.roleOf(m.sender, { fromMe: m.fromMe, role: conn.role })
    if (!roles.isOwner && ((settings.self && !m.fromMe) || (settings.pconly && m.isGroup) || (settings.gconly && !m.isGroup))) return
    if (u.banned && u.banExpires && u.banExpires <= now()) { u.banned = false; u.banReason = ''; u.banExpires = 0 }
    if (!roles.isOwner && (u.banned || chat.isBanned)) return
    // Premium kedaluwarsa dicabut di sini (satu definisi di
    // lib/helpers/premium.js); limit harian diisi ulang ke batas bawaan
    // HANYA bila sudah habis (keputusan Veo 2026-11-25) — sisa yang
    // masih ada dibawa ke hari berikutnya, tidak direset.
    refreshPremium(u, now())
    const today = dayKey(now(), config.timezone ?? global.timezone ?? 'Asia/Jakarta')
    if (u.limitDay !== today) { u.limitDay = today; if (u.limit <= 0) u.limit = Math.max(0, Math.floor(Number(globalThis.defaultLimit ?? 50))) }
    let metadata = m.isGroup ? await conn.store.getGroupMetadata(m.chat) : null, participants = metadata?.participants ?? []
    const find = id => participants.find(p => [p.id, p.lid, p.phoneNumber].some(v => conn.identity.same(v, id)))
    const findBot = () => participants.find(p => [p.id, p.lid, p.phoneNumber].some(v => conn.identity.isBot(v) && conn.identity.self.some(id => conn.identity.same(id, v))))
    let user = find(m.sender), bot = findBot()
    // Deteksi admin real-time (insiden KDN 2026-11-26): promosi bot yang
    // kelewat event group-participants.update (mis. saat reconnect)
    // membuat cache metadata basi — bot sudah admin tapi cache masih
    // bilang bukan, dan isBotAdmin yang salah menolak perintah. Bila
    // terbaca bukan admin, paksa refresh sekali dari server lalu hitung
    // ulang. Store membatasi refresh 1x/60 detik per grup, jadi grup yang
    // memang bukan admin tidak memicu fetch di setiap pesan.
    if (m.isGroup && !['admin', 'superadmin'].includes(bot?.admin) && conn.store.refreshGroupMetadata) {
      const fresh = await conn.store.refreshGroupMetadata(m.chat).catch(() => null)
      if (fresh && fresh !== metadata) { metadata = fresh; participants = fresh.participants ?? []; user = find(m.sender); bot = findBot() }
    }
    const premiumActive = isPremium(u, now())
    const context = { m, conn, ...roles, isPrems: roles.isMods || premiumActive, premium: { active: premiumActive, remainingMs: premiumRemainingMs(u, now()), remaining: formatPremiumRemaining(u, now()) }, participants, groupMetadata: metadata, user, bot, userData: u, chat, settings, isAdmin: ['admin', 'superadmin'].includes(user?.admin), isRAdmin: user?.admin === 'superadmin', isBotAdmin: ['admin', 'superadmin'].includes(bot?.admin), chatUpdate }
    if (config.legacyAliases !== false) context.isROwner = roles.isFounder
    const ctxFor = (id, extra = {}) => ({ ...context, __filename: path.join(plugins.root, id), __dirname: path.dirname(path.join(plugins.root, id)), ...extra })
    try {
      if (settings.autoread) await conn.chatRead(m.key.remoteJid, m.key.participant, m.id)
      const snapshot = list()
      for (const { id, plugin } of snapshot) if (plugin.all) await hook(plugin.all, conn, m, { conn, chatUpdate, __filename: path.join(plugins.root, id), __dirname: path.dirname(path.join(plugins.root, id)) }, id)
      const skipped = new Set()
      for (const { id, plugin } of snapshot) if (plugin.before && await hook(plugin.before, conn, m, ctxFor(id), id)) skipped.add(id)
      await users.run(m.sender, async () => {
        let firstFail, ran = false
        const prefix = settings.prefix ?? config.prefix ?? '.!/#$'
        // Fallback .unprefix (per-grup, plugins/group/unprefix.js):
        // input sintetis bila kata pertama pesan cocok whole-word dengan
        // daftar unprefix grup ini — dihitung sekali per pesan. null bila
        // tidak ada kata yang cocok; daftar kosong di DM berarti tidak
        // pernah cocok di sana.
        const unprefixInput = unprefixFallbackInput(m.text, chat.unprefix, prefix)
        // Dispatch memakai daftar plugin PENUH (bukan snapshot yang
        // menyaring disabled), supaya command plugin yang dimatikan
        // masih dikenali dan dijawab — bukan diam-diam diabaikan.
        // Hook all/before di atas tetap memakai snapshot, jadi hook
        // plugin yang dimatikan juga tidak jalan.
        for (const { id, plugin } of plugins.list()) {
          if (skipped.has(id) || typeof plugin !== 'function') continue
          let parsed = parseCommand(plugin, m.text, prefix)
          // Bila parse normal gagal, coba jalur unprefix dengan input
          // sintetis — parse normal selalu didahulukan, jadi perintah
          // ber-prefix dan prefixless yang sudah ada (cekprefix,
          // eval/exec, odelete) tidak terganggu. Alur sesudahnya
          // (disabled, permission, cooldown, limit) terpakai apa adanya:
          // unprefix hanya mengubah trigger, bukan izin.
          if (!parsed && unprefixInput) parsed = parseCommand(plugin, unprefixInput, prefix)
          if (!parsed) continue
          const ctx = ctxFor(id, parsed)
          // Plugin yang dimatikan (handler.disabled): tolak di sini,
          // SEBELUM pra-cek limit di permissionFailure — tidak makan
          // limit, tidak kena cooldown, berlaku untuk semua orang
          // termasuk founder/owner.
          if (plugin.disabled) { firstFail ??= { type: 'disabled', plugin, command: (parsed.usedPrefix ?? '') + parsed.command, chatName: metadata?.subject ?? null }; continue }
          const failure = now() - (cooldown.get(m.sender) ?? -Infinity) < (config.cooldownMs ?? 1000) ? 'cooldown' : permissionFailure(plugin, ctx)
          if (failure) { firstFail ??= { type: failure, plugin, command: (parsed.usedPrefix ?? '') + parsed.command, chatName: metadata?.subject ?? null }; continue }
          cooldown.set(m.sender, now()); m.isCommand = true; m.plugin = id; noteGuardCommand(); m.error = null; m.limit = Math.max(0, Number(plugin.limit) || 0); m.exp = Number.isFinite(plugin.exp) ? plugin.exp : 10
          let success = false
          const stats = db.ensure('stats', id)
          try { await plugin.call(conn, m, ctx); success = true }
          catch (e) {
            m.error = e; error(e, { plugin: id, command: parsed.command, chat: m.chat })
            await conn.reply(m.chat, typeof e === 'string' ? redact(e) : config.eror || messages.internal, m)
            if (e instanceof Error && !reports.get(id)) {
              reports.set(id, true)
              // Reports are replies only to a founder who previously contacted this process.
              const founder = (config.founder ?? []).map(([pn]) => pn + '@s.whatsapp.net').find(pn => inbound.has(pn))
              if (founder) try { await conn.reply(founder, redact(`Plugin ${id}; command ${parsed.command}: ${e.name}: ${e.message}`).slice(0, 3000)) } catch (reportError) { error(reportError, { plugin: id, stage: 'error-report' }) }
            }
          } finally {
            if (plugin.after) await hook(plugin.after, conn, m, ctx, id)
            stats.total++; stats.last = now(); stats[success ? 'success' : 'fail']++
            // Deduksi hanya bila handler sukses (throw = tidak dipakai).
            // Handler boleh membebaskan pemakaian ini dengan m.limit = 0
            // (langkah yang hanya membuat sesi, mis. .sa foto, atau
            // pembatalan): pra-cek di permissionFailure tetap memakai
            // handler.limit statis, jadi limit >= biaya tetap disyaratkan
            // untuk memulai.
            if (success) { stats.lastSuccess = now(); if (!ctx.isPrems) u.limit = Math.max(0, u.limit - Math.max(0, Number(m.limit) || 0)); u.exp += Math.max(0, Number(m.exp) || 0) }
          }
          ran = true; break
        }
        if (!ran && firstFail) {
          if (firstFail.type === 'founder') {
            try { await notifyFounderAttempt(conn, config, m, firstFail) } catch (notifyError) { error(notifyError, { plugin: firstFail.plugin, stage: 'founder-notify' }) }
          } else if (firstFail.type === 'limit') await conn.reply(m.chat, limitText(u.limit, Math.max(0, Math.floor(Number(globalThis.defaultLimit ?? 50)))), m)
          else await (firstFail.plugin.fail ?? dfail)(firstFail.type, m, conn)
        }
      })
    } finally { log(m, conn) }
  }
  const inbound = new TTLCache({ max: 5000, ttl: 86400000, now })
  const allowedEvent = (chat, limit, type) => { const key = type + ':' + chat, n = eventRates.get(key) ?? 0; if (n >= limit) return false; eventRates.set(key, n + 1, Math.max(1, 60000 - (now() % 60000))); return true }
  return {
    async handler(update) {
      if (update.type !== 'notify') return
      const conn = this
      await Promise.all((update.messages ?? []).map(raw => queue.run(raw.key?.remoteJid ?? 'invalid', async () => { try { if (!raw.key?.fromMe && kind(raw.key?.remoteJid) !== 'group') { const pn = await conn.toJid(raw.key.remoteJid, { key: raw.key }); if (pn) inbound.set(pn, true) } await processOne(conn, raw, update) } catch (e) { error(e, { stage: 'intake' }) } })))
    },
    async participantsUpdate({ id, participants, action, author }) {
      const conn = this, chat = db.ensure('chats', id)
      if (cfg(conn).self || (!chat.welcome && !chat.detect)) return
      if (!['add', 'remove', 'promote', 'demote'].includes(action)) return
      if ((['add', 'remove'].includes(action) && !chat.welcome) || (['promote', 'demote'].includes(action) && !chat.detect)) return
      const metadata = await conn.store.getGroupMetadata(id)
      conn.identity.learnContext({ participants })
      for (const p of participants.slice(0, 20)) {
        const target = p.lid || p.id || p.phoneNumber
        if (conn.identity.self.some(me => conn.identity.same(me, target)) || !allowedEvent(id, 10, 'group')) continue
        const [mention] = await conn.identity.forAction([target], 'mention', { groupMetadata: metadata })
        if (!mention) continue
        const field = { add: 'sWelcome', remove: 'sBye', promote: 'sPromote', demote: 'sDemote' }[action]
        const template = chat[field] || messages[{ add: 'welcome', remove: 'bye', promote: 'promote', demote: 'demote' }[action]]
        await conn.reply(id, template.replaceAll('@user', '@' + jidDecode(mention).user).replaceAll('@subject', metadata.subject ?? '').replaceAll('@desc', metadata.desc ?? '').slice(0, 3500), undefined, { mentions: [mention] })
      }
    },
    async groupsUpdate(updates) {
      const conn = this
      for (const update of updates) {
        const chat = db.ensure('chats', update.id)
        if (!chat.detect || cfg(conn).self || conn.identity.self.some(me => conn.identity.same(me, update.author || update.actor))) continue
        for (const key of ['subject', 'desc', 'icon', 'revoke', 'announce', 'restrict']) if (Object.hasOwn(update, key) && allowedEvent(update.id, 10, 'group')) {
          const template = chat[{ subject: 'sSubject', desc: 'sDesc', icon: 'sIcon', revoke: 'sRevoke' }[key]] || messages[key]
          await conn.reply(update.id, template.replaceAll('@subject', update.subject ?? '').replaceAll('@desc', update.desc ?? '').slice(0, 3500))
        }
      }
    },
    async deleteUpdate(upd) {
      const chat = db.data.chats[upd.chat]
      if (!chat || chat.delete !== true) return
      const conn = this
      if (cfg(conn).self || upd.revokerIsBot || kind(upd.chat) === 'broadcast') return
      const original = conn.store.loadMessage(upd.id)
      if (!original) return
      const deletionKey = 'revoke:' + upd.chat + ':' + upd.id
      if (dedupe.get(deletionKey)) return
      const m = smsg(conn, original)
      if (m.fromMe || conn.identity.isBot(m.sender) || !allowedEvent(upd.chat, 3, 'delete')) return
      dedupe.set(deletionKey, true)
      const [target] = await conn.identity.forAction([m.sender], 'mention')
      await conn.reply(upd.chat, `${target ? '@' + jidDecode(target).user : 'Pengirim'} menghapus pesan.`, undefined, { mentions: target ? [target] : [] })
      await conn.copyNForward(upd.chat, original, true)
    },
    close: () => queue.close(),
  }
}
