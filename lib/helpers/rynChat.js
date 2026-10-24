import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

// Sisi bot dari chat dua arah Ryn <-> pengguna lewat WhatsApp.
//
// Kebalikan localBridge: di sini PENGGUNA yang menulis ke Ryn. Pesan
// (perintah .ryn, trigger nama, atau teks biasa selama mode percakapan
// menyala) ditulis sebagai file JSON ke src/private/bridge/to-ryn/ —
// folder privat yang sama (gitignored). Di sisi VM, hook Muse memungut
// file-file itu, mengelompokkan per chat, lalu membangunkan Ryn untuk
// menjawab lewat localBridge (say ke DM founder, reply ke chat asal).
//
// Jangkauan diatur founder lewat .config:
// - rynScope: 'private' (DM founder saja, bawaan) | 'group' | 'both'
// - rynUsers: siapa yang boleh memanggil di grup — 'founder' | 'anyone'.
//   DM SELALU founder-only, berapa pun nilai kunci ini.
// - rynGroups: allowlist JID grup; kosong = semua grup.
//
// State sesi mode percakapan tinggal di src/private/bridge/ryn-session.json
// (dibaca juga oleh hook untuk tahu kapan memantau lebih rapat): sesi kini
// PER CHAT (kunci = JID chat; di grup hanya teks dari PEMBUKA sesi yang
// diteruskan — anggota lain memakai .ryn / trigger nama). Field ringkasan
// tingkat atas (active/since/expiresAt) tetap dipertahankan untuk hook:
// active = ada sesi hidup, since = sejak paling awal, expiresAt = mati
// paling akhir. Sesi mati otomatis setelah RYN_SESSION_TTL_MS tanpa pesan.

export const RYN_SESSION_TTL_MS = 5 * 60 * 1000
export const RYN_MAX_TEXT = 4000
const TEXT_TYPES = new Set(['conversation', 'extendedTextMessage'])
const PREFIX_CHARS = '.!/#$'

// Pisah flag --on/--off (di posisi mana pun) dari teks input awal.
// '.ryn halo --on dunia' -> { flag: 'on', input: 'halo dunia' }
export function parseRynArgs(text = '') {
  const tokens = String(text).split(/\s+/).filter(Boolean)
  let flag = null
  const rest = []
  for (const token of tokens) {
    if (token === '--on' || token === '--off') { flag = token.slice(2); continue }
    rest.push(token)
  }
  return { flag, input: rest.join(' ') }
}

// Trigger panggilan nama: pesan yang DIAWALI panggilan "Ryn" (berdiri sendiri
// sebagai kata pertama, boleh diikuti tanda baca) dianggap memanggil Ryn.
// Mengembalikan { input } — sisa teks setelah panggilan (boleh kosong) —
// atau null bila bukan panggilan. "Ryna ...", "kemarin Ryn ..." -> null:
// nama di tengah kalimat hampir pasti sedang dibicarakan, bukan dipanggil.
export function parseNameCall(text = '') {
  const t = String(text).trim()
  const m = /^ryn\b[,:.!?]*\s*(.*)$/is.exec(t)
  if (!m) return null
  return { input: (m[1] ?? '').trim() }
}

// Deteksi trigger sekali jalan untuk pesan bebas yang LOLOS gerbang
// shouldForward. Urutan prioritas: panggilan nama (paling eksplisit) >
// reply ke pesan bot > mention/tag bot. Untuk 'reply'/'mention', seluruh
// teks pesan adalah isi panggilan (tidak ada yang distrip). Toggle dari
// .config: rynTriggerReply / rynTriggerMention. Mengembalikan
// { via } | null. Keputusan ini murni sisi bot — pesan yang tidak kena
// trigger apa pun tidak pernah masuk antrean to-ryn.
export function detectRynTrigger({ nameInput = null, quotedFromBot = false, mentionsBot = false, replyOn = true, mentionOn = true } = {}) {
  if (nameInput !== null) return { via: 'name' }
  if (replyOn && quotedFromBot) return { via: 'reply' }
  if (mentionOn && mentionsBot) return { via: 'mention' }
  return null
}

// Apakah (scope, jenis chat) mengizinkan fitur Ryn berjalan di sini.
export function scopeAllows(scope, isGroup) {
  if (isGroup) return scope === 'group' || scope === 'both'
  return scope === 'private' || scope === 'both'
}

// Apakah pengirim ini boleh memanggil Ryn di konteks chat tersebut.
// DM selalu founder-only; di grup mengikuti rynUsers.
export function userAllowed({ isGroup, isFounder, users = 'anyone' } = {}) {
  if (!isGroup) return !!isFounder
  return !!isFounder || users === 'anyone'
}

// Keputusan handler.before: pesan ini kandidat untuk diteruskan ke Ryn
// (sebagai teks sesi atau trigger nama) atau tidak. Tetap ketat: hanya
// teks biasa bukan perintah, bukan dari bot sendiri, jangkauan config
// mengizinkan, grup lolos allowlist, dan pengirim berhak. Pesan berawalan
// karakter prefix dianggap wilayah perintah bot.
export function shouldForward({ text, mtype, isGroup, fromMe, isFounder, bridgeOn, scope = 'private', users = 'anyone', chatAllowed = true } = {}) {
  if (!bridgeOn || fromMe) return false
  if (!scopeAllows(scope, !!isGroup)) return false
  if (isGroup && !chatAllowed) return false
  if (!userAllowed({ isGroup: !!isGroup, isFounder, users })) return false
  if (!TEXT_TYPES.has(mtype)) return false
  const t = String(text ?? '').trim()
  if (!t) return false
  if (PREFIX_CHARS.includes(t[0])) return false
  return true
}

export function createRynChat({ root, now = Date.now } = {}) {
  const baseDir = path.join(root, 'src', 'private', 'bridge')
  const queueDir = path.join(baseDir, 'to-ryn')
  const sessionFile = path.join(baseDir, 'ryn-session.json')

  function normalizeState(raw) {
    const s = raw && typeof raw === 'object' ? raw : {}
    const sessions = s.sessions && typeof s.sessions === 'object' ? s.sessions : {}
    return { ...s, sessions }
  }

  async function readSession() {
    try { return normalizeState(JSON.parse(await fsp.readFile(sessionFile, 'utf8'))) }
    catch { return { sessions: {} } }
  }

  // Tulis state + segarkan ringkasan tingkat atas untuk hook.
  async function writeSession(state, at = now()) {
    const sessions = state.sessions ?? {}
    const live = Object.values(sessions).filter(x => x?.active && x.expiresAt > at)
    const summary = {
      active: live.length > 0,
      since: live.length ? Math.min(...live.map(x => x.since ?? at)) : 0,
      expiresAt: live.length ? Math.max(...live.map(x => x.expiresAt ?? 0)) : 0,
    }
    const out = { ...state, sessions, ...summary }
    await fsp.mkdir(baseDir, { recursive: true })
    const tmp = `${sessionFile}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(out))
    await fsp.rename(tmp, sessionFile)
    return out
  }

  async function enqueue(entry) {
    await fsp.mkdir(queueDir, { recursive: true })
    const ts = now()
    const id = `${ts}-${crypto.randomBytes(3).toString('hex')}`
    const file = path.join(queueDir, `${id}.json`)
    const tmp = `${file}.tmp`
    await fsp.writeFile(tmp, JSON.stringify({ id, ts: new Date(ts).toISOString(), ...entry }, null, 2))
    await fsp.rename(tmp, file)
    return id
  }

  function liveEntry(state, chat, at) {
    const entry = state.sessions?.[chat]
    if (!entry?.active) return null
    return entry.expiresAt > at ? entry : null
  }

  return {
    dirs: { baseDir, queueDir },
    sessionFile,
    readSession,
    enqueue,

    async startSession(chat, { by = null } = {}, at = now()) {
      const state = await readSession()
      state.sessions[chat] = { active: true, by, since: at, lastMessageAt: at, expiresAt: at + RYN_SESSION_TTL_MS }
      return writeSession(state, at)
    },

    async endSession(chat, at = now()) {
      const state = await readSession()
      const entry = state.sessions[chat]
      if (entry) state.sessions[chat] = { ...entry, active: false, endedAt: at }
      return writeSession(state, at)
    },

    // Status sesi SATU chat pada waktu `at`; yang lewat expiresAt ditandai
    // mati (lazy expiry) supaya pembaca lain konsisten.
    async sessionActive(chat, at = now()) {
      const state = await readSession()
      const entry = state.sessions?.[chat]
      if (!entry?.active) return false
      if (entry.expiresAt > at) return true
      state.sessions[chat] = { ...entry, active: false, endedAt: entry.expiresAt, expired: true }
      await writeSession(state, at).catch(() => {})
      return false
    },

    // Teruskan satu teks biasa selama mode percakapan chat ini menyala.
    // Di grup, hanya teks dari pembuka sesi yang diteruskan ('not-owner'
    // untuk pengirim lain). Mengembalikan
    // 'forwarded' | 'off' | 'expired' | 'not-owner'.
    async forwardSessionMessage({ text, msgId, chat, from = null, senderName = null, quoted = null, origText = null, sameUser = (a, b) => a === b } = {}, at = now()) {
      const state = await readSession()
      const entry = state.sessions?.[chat]
      if (!entry?.active) return 'off'
      if (!(entry.expiresAt > at)) {
        state.sessions[chat] = { ...entry, active: false, endedAt: entry.expiresAt, expired: true }
        await writeSession(state, at).catch(() => {})
        return 'expired'
      }
      if (entry.by && from && !sameUser(entry.by, from)) return 'not-owner'
      state.sessions[chat] = { ...entry, lastMessageAt: at, expiresAt: at + RYN_SESSION_TTL_MS }
      await writeSession(state, at)
      await enqueue({ type: 'message', mode: 'session', text: String(text ?? '').slice(0, RYN_MAX_TEXT), msgId: msgId ?? null, chat: chat ?? null, from: from ?? null, senderName: senderName ?? null, isGroup: String(chat ?? '').endsWith('@g.us'), ...(quoted ? { quoted } : {}), ...(origText ? { origText: String(origText).slice(0, 1000) } : {}) })
      return 'forwarded'
    },
  }
}
