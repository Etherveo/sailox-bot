import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

// Sisi bot dari chat dua arah Ryn <-> founder lewat WhatsApp.
//
// Kebalikan localBridge: di sini FOUNDER yang menulis ke Ryn. Pesan founder
// (perintah .ryn atau teks biasa selama mode percakapan menyala) ditulis
// sebagai file JSON ke src/private/bridge/to-ryn/ — folder privat yang sama
// (gitignored). Di sisi VM, hook Muse memungut file-file itu, mengumpulkan
// satu batch, lalu membangunkan Ryn untuk menjawab lewat localBridge (say).
//
// State sesi mode percakapan tinggal di src/private/bridge/ryn-session.json
// (dibaca juga oleh hook untuk tahu kapan harus memantau lebih rapat dan
// kapan sesi kedaluwarsa). Sesi mati otomatis setelah RYN_SESSION_TTL_MS
// tanpa pesan founder — kedaluwarsa diterapkan malas (lazy) di sini saat
// pesan berikutnya datang, dan oleh hook saat tidak ada pesan sama sekali.

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

// Keputusan handler.before: pesan ini layak diteruskan ke Ryn sebagai teks
// sesi atau tidak. Sengaja ketat — hanya teks biasa dari founder di DM.
// Pesan berawalan karakter prefix dianggap wilayah perintah bot.
export function shouldForward({ text, mtype, isGroup, fromMe, isFounder, bridgeOn } = {}) {
  if (!bridgeOn || fromMe || isGroup || !isFounder) return false
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

  async function readSession() {
    try {
      const s = JSON.parse(await fsp.readFile(sessionFile, 'utf8'))
      return s && typeof s === 'object' ? s : { active: false }
    } catch { return { active: false } }
  }

  async function writeSession(session) {
    await fsp.mkdir(baseDir, { recursive: true })
    const tmp = `${sessionFile}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(session))
    await fsp.rename(tmp, sessionFile)
    return session
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

  return {
    dirs: { baseDir, queueDir },
    sessionFile,
    readSession,
    enqueue,

    async startSession(at = now()) {
      return writeSession({ active: true, since: at, lastMessageAt: at, expiresAt: at + RYN_SESSION_TTL_MS })
    },

    async endSession(at = now()) {
      const s = await readSession()
      return writeSession({ ...s, active: false, endedAt: at })
    },

    // Status sesi pada waktu `at`; sesi yang lewat expiresAt dianggap mati
    // dan ditandai tidak aktif (lazy expiry) supaya pembaca lain konsisten.
    async sessionActive(at = now()) {
      const s = await readSession()
      if (!s.active) return false
      if (s.expiresAt > at) return true
      await writeSession({ ...s, active: false, endedAt: s.expiresAt, expired: true }).catch(() => {})
      return false
    },

    // Teruskan satu teks biasa founder selama mode percakapan menyala.
    // Mengembalikan 'forwarded' | 'off' | 'expired'.
    async forwardSessionMessage({ text, msgId, chat } = {}, at = now()) {
      const s = await readSession()
      if (!s.active) return 'off'
      if (!(s.expiresAt > at)) {
        await writeSession({ ...s, active: false, endedAt: s.expiresAt, expired: true }).catch(() => {})
        return 'expired'
      }
      await writeSession({ ...s, lastMessageAt: at, expiresAt: at + RYN_SESSION_TTL_MS })
      await enqueue({ type: 'message', mode: 'session', text: String(text ?? '').slice(0, RYN_MAX_TEXT), msgId: msgId ?? null, chat: chat ?? null })
      return 'forwarded'
    },
  }
}
