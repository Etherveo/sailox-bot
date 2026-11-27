// .blacklist — daftar hitam global: orang yang masuk daftar langsung
// di-kick dari semua grup yang dimasuki bot (bila bot admin di grup itu).
//
//   .blacklist add <target> — masukkan ke blacklist
//   .blacklist del <target> — hapus dari blacklist
//   .blacklist list         — lihat daftar
//   .blacklist <target>     — tanpa aksi: bot bertanya dulu (jawab
//                             `add`/`del`, sesi singkat 15 detik)
//
// Target: reply, tag (@...), nomor, atau JID/LID yang diketik utuh
// (pakai parseTargets + resolveMentionTargets dari
// #lib/helpers/groupTargets.js, seperti .kick; JID/LID utuh ditangani
// fallback normalize karena parseTargets tidak menangkapnya). Yang
// disimpan: JID DAN LID-nya (diuraikan lewat conn.identity, seperti
// .banchat) — pengirim bisa tiba sebagai JID atau LID, jadi penegakan
// membandingkan dengan conn.identity.same, bukan `===` mentah.
//
// Store: koleksi 'blacklist' (lib/database/collections/blacklist.js) =
// databases/blacklist.json, satu record per orang { jid, lid, addedBy,
// addedAt }. Koleksi ini GLOBAL, jadi di sub-bot otomatis terpisah:
// worker membaca databases/blacklist.json DI DALAM sandbox-nya sendiri
// (tanpa branching isSubBotContext — itu hanya untuk store per-chat
// seperti .unprefix). Semua logic store ada di file ini (AGENTS.md
// §12: satu fitur, satu plugin) dan diekspor untuk tes.
//
// Penegakan — handler.all di bawah: setiap pesan masuk di grup, bila
// pengirim ada di blacklist dan bot admin di grup itu, langsung
// di-kick (conn.groupParticipantsUpdate — dibungkus identity.forAction
// + retry LID di lib/simple.js). Diam (tanpa error, tanpa balasan)
// bila: bukan grup, pengirim bukan di blacklist, bot bukan admin,
// pengirim bot sendiri/owner/founder, atau kick gagal (mis. target
// pembuat grup). Cooldown kecil per (chat, pengirim) supaya pesan
// beruntun tidak memicu percobaan kick berulang.
//
// KETERBATASAN (jangan diubah pipeline-nya): pipeline
// (lib/plugins/pipeline.js) mengembalikan pesan dari chat yang
// di-banchat SEBELUM hook all jalan — jadi di grup yang di-banchat,
// penegakan blacklist tidak jalan untuk non-owner. Di grup yang tidak
// di-banchat, penegakan jalan normal.
import { normalize, kind } from '#lib/identity/resolver.js'
import { parseTargets, resolveMentionTargets, digitsOf } from '#lib/helpers/groupTargets.js'

export const BLACKLIST_SESSION_TTL_MS = 15 * 1000
export const BLACKLIST_KICK_COOLDOWN_MS = 60 * 1000
export const BLACKLIST_LIST_MAX = 50

const USAGE = [
  'Contoh: .blacklist add @tag — atau reply pesannya / ketik nomornya.',
  '.blacklist del <target> — hapus dari blacklist.',
  '.blacklist list — lihat daftar.',
  'Tanpa add/del, bot bertanya dulu (jawab add/del, 15 detik).',
].join('\n')

// ─── Sesi tanya-aksi (in-memory, keyed chat|pengirim) ───────────────────
// Pola yang sama seperti penawaran oversize .pilih
// (plugins/anime/pilih.js): put menimpa sesi lama, peek tidak menghapus,
// take mengambil + menghapus sekaligus melaporkan kedaluwarsa.
export function createBlacklistActionStore({ ttlMs = BLACKLIST_SESSION_TTL_MS, now = Date.now } = {}) {
  const map = new Map()
  const keyOf = (chat, sender) => `${chat}|${sender}`
  return {
    put(chat, sender, data) {
      const t = now()
      for (const [k, v] of map) if (v.expiresAt <= t) map.delete(k)
      map.set(keyOf(chat, sender), { ...data, expiresAt: t + ttlMs })
    },
    peek(chat, sender) {
      const s = map.get(keyOf(chat, sender))
      if (!s) return null
      return { ...s, expired: s.expiresAt <= now() }
    },
    take(chat, sender) {
      const s = map.get(keyOf(chat, sender))
      if (!s) return null
      map.delete(keyOf(chat, sender))
      return { ...s, expired: s.expiresAt <= now() }
    },
    delete(chat, sender) { map.delete(keyOf(chat, sender)) },
  }
}
const blacklistActions = createBlacklistActionStore()

// ─── Cooldown percobaan kick (in-memory, per chat|pengirim) ─────────────
export function createBlacklistKickCooldown({ ttlMs = BLACKLIST_KICK_COOLDOWN_MS, now = Date.now } = {}) {
  const map = new Map()
  return {
    // true bila masih dalam masa cooldown (jangan coba kick lagi).
    check(chat, sender) {
      const t = now()
      for (const [k, v] of map) if (v <= t) map.delete(k)
      return (map.get(`${chat}|${sender}`) ?? 0) > t
    },
    mark(chat, sender) { map.set(`${chat}|${sender}`, now() + ttlMs) },
    clear() { map.clear() },
  }
}
const kickCooldown = createBlacklistKickCooldown()
export function clearBlacklistKickCooldown() { kickCooldown.clear() }

// ─── Store koleksi 'blacklist' ──────────────────────────────────────────
export function listBlacklistEntries(db) {
  return Object.entries(db?.data?.blacklist ?? {})
    .filter(([, rec]) => rec && typeof rec === 'object')
    .map(([key, rec]) => ({ key, jid: rec.jid ?? '', lid: rec.lid ?? '', addedBy: rec.addedBy ?? '', addedAt: rec.addedAt ?? 0 }))
}

export function findBlacklistEntry(db, conn, id) {
  if (!id) return null
  for (const e of listBlacklistEntries(db)) {
    if (conn.identity.same(e.key, id) || conn.identity.same(e.jid, id) || conn.identity.same(e.lid, id)) return e
  }
  return null
}

export function isBlacklisted(db, conn, id) { return !!findBlacklistEntry(db, conn, id) }

// Tambah (atau gabung ke record yang sudah ada bila orangnya sudah
// tercatat lewat bentuk lain): JID/LID yang baru diketahui ikut
// disimpan supaya penegakan tetap kena lewat bentuk mana pun. Kedua
// bentuk dicek — tanpa ini, tambah lewat JID lalu tambah lagi lewat
// LID (sebelum pemetaannya diketahui) membuat dua record.
export async function addBlacklistEntry(db, conn, { jid, lid, addedBy }) {
  const existing = (lid && findBlacklistEntry(db, conn, lid)) || (jid && findBlacklistEntry(db, conn, jid)) || null
  const key = existing?.key ?? (lid ?? jid)
  const rec = db.ensure('blacklist', key)
  if (jid) rec.jid = jid
  if (lid) rec.lid = lid
  rec.addedBy = addedBy ?? rec.addedBy ?? ''
  rec.addedAt = Date.now()
  await db.save('blacklist')
  return { key, jid: rec.jid, lid: rec.lid, addedBy: rec.addedBy, addedAt: rec.addedAt, updated: !!existing }
}

// Hapus SEMUA record yang cocok dengan target (bentuk JID dan/atau
// LID): satu orang bisa punya dua record bila ditambahkan lewat dua
// bentuk sebelum pemetaannya diketahui — keduanya harus hilang.
export async function delBlacklistEntry(db, conn, idOrTarget) {
  const ids = typeof idOrTarget === 'string' ? [idOrTarget] : [idOrTarget?.jid, idOrTarget?.lid].filter(Boolean)
  let removed = null
  for (const e of listBlacklistEntries(db)) {
    if (ids.some(id => conn.identity.same(e.key, id) || conn.identity.same(e.jid, id) || conn.identity.same(e.lid, id))) {
      delete db.data.blacklist[e.key]
      removed ??= e
    }
  }
  if (removed) await db.save('blacklist')
  return removed
}

// ─── Target ─────────────────────────────────────────────────────────────
// Urut prioritas: tag -> reply -> nomor yang diketik (parseTargets),
// lalu fallback JID/LID utuh yang diketik (normalize) — parseTargets
// tidak menangkap bentuk itu karena polanya hanya digit.
async function resolveBlacklistTarget(m, ctx, targetText) {
  const { conn, participants } = ctx
  const parsed = parseTargets({ mentionedJid: m.mentionedJid, quotedSender: m.quoted?.sender, text: targetText })
  let primary = parsed[0]?.id ?? null
  if (!primary && targetText) {
    const n = normalize(String(targetText).trim())
    if (n && (kind(n) === 'pn' || kind(n) === 'lid')) primary = n
  }
  if (!primary) return null
  const resolved = await conn.identity.resolve(primary, { participants })
  if (!resolved || (!resolved.lid && !resolved.jid)) return null
  return { jid: resolved.jid ?? null, lid: resolved.lid ?? null, primary }
}

// Label tampil + mention final untuk balasan (pola .kick/.tagme:
// bentuk mention diminta dulu, digit label diambil dari bentuk itu).
async function targetLabel(conn, ctx, target) {
  const [t] = await resolveMentionTargets(conn, [{ id: target.primary, digits: digitsOf(target.primary) }], { participants: ctx.participants, groupMetadata: ctx.groupMetadata })
  return { label: t?.mentionLabel ?? `@${digitsOf(target.primary)}`, mentionId: t?.mentionId ?? target.primary }
}

function assertAddable(conn, target) {
  for (const id of [target.jid, target.lid, target.primary]) {
    if (!id) continue
    if (conn.identity.isBot(id)) throw 'Target adalah bot itu sendiri.'
    if (conn.identity.roleOf(id).isOwner) throw 'Owner/founder tidak bisa di-blacklist.'
  }
}

// ─── Command ────────────────────────────────────────────────────────────
let handler = async (m, ctx) => {
  const { conn, text } = ctx
  const db = global.db
  const argText = String(text ?? '').trim()
  const words = argText ? argText.split(/\s+/) : []
  const first = (words[0] ?? '').toLowerCase()

  if (first === 'list' && words.length === 1) {
    const entries = listBlacklistEntries(db)
    if (!entries.length) return m.reply('Blacklist masih kosong.')
    const shown = entries.slice(0, BLACKLIST_LIST_MAX)
    const lines = shown.map((e, i) => `${i + 1}. @${digitsOf(e.jid || e.lid)}`)
    if (entries.length > shown.length) lines.push(`…dan ${entries.length - shown.length} lagi.`)
    return conn.reply(m.chat, lines.join('\n'), m, { mentions: shown.map(e => e.lid || e.jid) })
  }

  const action = first === 'add' || first === 'del' ? first : null
  const targetText = action ? words.slice(1).join(' ') : argText
  const hasTargetSource = !!targetText || !!m.quoted?.sender || (m.mentionedJid?.length ?? 0) > 0
  if (!hasTargetSource) return m.reply(USAGE)

  const target = await resolveBlacklistTarget(m, ctx, targetText)
  if (!target) throw 'Target tidak dikenali. Pakai reply, tag, atau nomor yang valid.'
  const { label, mentionId } = await targetLabel(conn, ctx, target)

  if (action === 'add') {
    assertAddable(conn, target)
    await addBlacklistEntry(db, conn, { jid: target.jid, lid: target.lid, addedBy: m.sender })
    return conn.reply(m.chat, `✅ ${label} masuk blacklist.`, m, { mentions: [mentionId] })
  }
  if (action === 'del') {
    const removed = await delBlacklistEntry(db, conn, target)
    return conn.reply(m.chat, removed ? `✅ ${label} dihapus dari blacklist.` : `ℹ️ ${label} tidak ada di blacklist.`, m, { mentions: [mentionId] })
  }

  // Tanpa aksi: tanya dulu, buka sesi singkat 15 detik.
  assertAddable(conn, target)
  const store = ctx?.blacklistActions ?? blacklistActions
  store.put(m.chat, m.sender, { jid: target.jid, lid: target.lid, label, mentionId })
  return conn.reply(m.chat, `Mau diapain ${label}?\nKetik *add* untuk memasukkan ke blacklist, atau *del* untuk menghapusnya — 15 detik.`, m, { mentions: [mentionId] })
}
handler.help = ['blacklist add <target>', 'blacklist del <target>', 'blacklist list']
handler.tags = ['owner']
handler.command = /^blacklist$/i
handler.owner = true
handler.sharing = true

// ─── Sesi tanya-aksi ────────────────────────────────────────────────────
// Pesan polos `add`/`del` (tanpa reply pesan bot) dari penanya di chat
// yang sama, dalam 15 detik, menjalankan aksinya. Pesan lain / tanpa
// sesi / dari orang lain / dari bot sendiri dilewati (return false).
// Peran dicek SEBELUM sesi diambil, supaya jawaban orang lain tidak
// membatalkan sesi owner yang masih terbuka.
handler.before = async (m, ctx) => {
  if (m.fromMe) return false
  const answer = (m.text ?? '').trim().toLowerCase()
  if (answer !== 'add' && answer !== 'del') return false
  const store = ctx?.blacklistActions ?? blacklistActions
  if (!store.peek(m.chat, m.sender)) return false
  if (!ctx?.isOwner && !ctx?.isFounder) return false
  const session = store.take(m.chat, m.sender)
  if (!session) return false
  if (session.expired) {
    await m.reply('Sesi sudah habis (15 detik). Ulangi perintahnya bila masih perlu.')
    return true
  }
  const db = global.db
  const { conn } = ctx
  if (answer === 'add') {
    await addBlacklistEntry(db, conn, { jid: session.jid, lid: session.lid, addedBy: m.sender })
    await conn.reply(m.chat, `✅ ${session.label} masuk blacklist.`, m, { mentions: session.mentionId ? [session.mentionId] : [] })
  } else {
    const removed = await delBlacklistEntry(db, conn, { jid: session.jid, lid: session.lid })
    await conn.reply(m.chat, removed ? `✅ ${session.label} dihapus dari blacklist.` : `ℹ️ ${session.label} tidak ada di blacklist.`, m, { mentions: session.mentionId ? [session.mentionId] : [] })
  }
  return true
}

// ─── Penegakan ──────────────────────────────────────────────────────────
// hook all: setiap pesan masuk di grup. Bot harus admin (dicek dari
// metadata grup yang sudah di-cache pipeline — getGroupMetadata
// mengembalikan cache 15 menit, bukan fetch per pesan). Kick gagal
// (status bukan 200, mis. target pembuat grup) ditelan diam-diam;
// cooldown per (chat, pengirim) mencegah percobaan berulang.
handler.all = async (m, { conn }) => {
  if (!m.isGroup || m.fromMe || !m.sender) return
  const db = global.db
  if (!db) return
  if (conn.identity.isBot(m.sender)) return
  if (conn.identity.roleOf(m.sender).isOwner) return
  if (!isBlacklisted(db, conn, m.sender)) return
  const cooldown = kickCooldown
  if (cooldown.check(m.chat, m.sender)) return
  let metadata
  try { metadata = await conn.store.getGroupMetadata(m.chat) } catch { return }
  if (!metadata) return
  // Entri bot di daftar peserta — samakan dengan cara pipeline
  // (findBot): hanya identitas bot sendiri, bukan peer lain.
  const botEntry = (metadata.participants ?? []).find(p => [p.id, p.lid, p.phoneNumber].some(v => v && conn.identity.self.some(me => conn.identity.same(me, v))))
  if (!botEntry || !['admin', 'superadmin'].includes(botEntry.admin)) return
  cooldown.mark(m.chat, m.sender)
  try {
    await conn.groupParticipantsUpdate(m.chat, [m.sender], 'remove')
  } catch { /* kick gagal (mis. pembuat grup): diam, cooldown sudah dipasang */ }
}

export default handler
