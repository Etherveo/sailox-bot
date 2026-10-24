import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { logger, printError } from '../print.js'

// Jembatan lokal Ryn: saluran perintah dari luar proses bot (file di
// src/private/bridge/inbox, folder itu gitignored) supaya Ryn — agen yang
// mengoperasikan VM ini — bisa menyuruh bot mengirim pesan atau menjalankan
// perintah, lalu mengaudit balasannya dari file hasil di outbox.
//
// Mode 'file' mengirim satu file lokal ke room owner lewat conn.sendFile
// (tipe stiker/gambar/video/audio/dokumen ditebak dari ekstensi). Path-nya
// di-jail ke workspace VM oleh resolveBridgeFile: folder sessions/,
// src/integrations/ (kredensial), .git/, .ssh/ dan file rahasia (.env,
// *.pem, *.key, token panel, dsb) ditolak keras.
//
// Batas keamanan (sengaja kaku):
// - Saklar global.bridge (kelola founder: .config set bridge on/off), bawaan mati.
// - Target TERKUNCI ke room owner (nomor founder pertama di config.js). Isi job
//   tidak bisa memilih chat/nomor lain — field target apa pun di file diabaikan.
// - Pengecualian terkendali: mode 'reply' membalas ke chat asal sebuah pesan
//   yang pernah diteruskan bot ke Ryn (antrean to-ryn, untuk fitur grup).
//   Job hanya membawa REF (id entri to-ryn); alamat tujuannya dibaca bot dari
//   catatan yang BOT SENDIRI tulis saat pesan itu masuk — job tetap tidak
//   bisa menyebut JID apa pun, dan entri kedaluwarsa (> 24 jam) ditolak.
// - Mode 'cmd' menyuntikkan pesan sintetis ke pipeline persis seperti pesan
//   owner sendiri (izin founder, cek plugin, balasan — semua jalur normal),
//   didahului pesan penanda dari bot supaya owner melihat perintah apa yang
//   sedang dites di room-nya.
// - Satu job per waktu, berurutan; balasan ke room owner selama job berjalan
//   disalin ke outbox untuk audit. Media balasan pada dasarnya METADATA SAJA
//   (kind, mimetype, ekstensi, ukuran, nama file, chat tujuan, timestamp) —
//   buffernya hanya ikut disimpan sebagai file bila kecil (< 5 MB, mis.
//   stiker/gambar hasil tes). Media yang ditangkap di sini adalah kiriman
//   KELUAR bot (payload sendMessage yang memang sudah berupa Buffer di
//   memori bot), jadi tidak ada unduhan tambahan dari WhatsApp.
// - Outbox dibersihkan otomatis: hasil berumur > 24 jam dihapus, jumlah
//   hasil dibatasi 100 job terbaru (media ikut terhapus bersama job-nya),
//   dan sisa file .tmp yatim di inbox ikut disapu. File inbox sendiri selalu
//   dihapus begitu job selesai diproses.

export const BRIDGE_TYPES = new Set(['say', 'cmd', 'file', 'reply'])
export const BRIDGE_SEND_MAX_BYTES = 150 * 1024 * 1024 // plafon kirim WA (maxMedia lib/simple.js)
const BLOCKED_SEGMENTS = new Set(['sessions', 'gdrive-auth', 'integrations', '.git', '.ssh'])
const BLOCKED_BASENAME = /^\.env|secret|credential|\.pem$|\.key$|panel-token/i

// Jail untuk mode 'file': file yang boleh dikirim Ryn lewat bridge hanyalah
// file di dalam workspace VM. Folder sesi/kredensial dan file rahasia
// diblokir keras — jembatan tidak boleh jadi jalan menguras rahasia bot.
export function resolveBridgeFile(root, requested) {
  const workspace = path.dirname(path.resolve(root))
  const abs = path.resolve(workspace, String(requested ?? ''))
  const rel = path.relative(workspace, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path file di luar workspace')
  const segments = rel.split(path.sep)
  if (segments.some(s => BLOCKED_SEGMENTS.has(s))) throw new Error('Folder itu terlarang untuk dikirim lewat bridge')
  if (BLOCKED_BASENAME.test(path.basename(abs))) throw new Error('File itu terlarang untuk dikirim lewat bridge')
  return abs
}
const FILE_RE = /^[A-Za-z0-9_-]{1,64}\.json$/
const MAX_JOB_BYTES = 16 * 1024
const MAX_TEXT = 4000
const MAX_REPLIES = 50
const MAX_MEDIA_FILES = 10
export const BRIDGE_MAX_MEDIA_BYTES = 5 * 1024 * 1024 // di atas ini outbox menyimpan metadata saja, tanpa file
export const BRIDGE_RETENTION_MS = 24 * 60 * 60 * 1000 // hasil outbox lebih tua dari ini dihapus otomatis
export const BRIDGE_MAX_OUTBOX_JOBS = 100 // hasil outbox dibatasi sekian job terbaru
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const QUIET_MS = 2500
const GRACE_MAX_MS = 20000
const sleep = ms => new Promise(r => setTimeout(r, ms))

export function ownerJidOf(config = globalThis) {
  const pn = config.founder?.[0]?.[0]
  return pn ? `${String(pn).replace(/\D/g, '')}@s.whatsapp.net` : null
}

const REPLY_REF_RE = /^[A-Za-z0-9_-]{1,80}$/
const CHAT_JID_RE = /^[^\s@]+@(g\.us|s\.whatsapp\.net|lid)$/

// Tujuan mode 'reply' dari satu entri antrean to-ryn (yang ditulis bot
// sendiri saat pesan masuk). Murni & bisa dites: lempar Error bila entri
// tidak layak jadi alamat balasan.
export function replyTargetOf(entry, nowMs = Date.now()) {
  if (!entry || typeof entry !== 'object') throw new Error('Entri asal untuk reply tidak ditemukan')
  const chat = entry.chat
  if (typeof chat !== 'string' || !CHAT_JID_RE.test(chat)) throw new Error('Entri asal tidak punya chat tujuan yang sah')
  const ts = Date.parse(entry.ts ?? '')
  if (Number.isFinite(ts) && nowMs - ts > BRIDGE_RETENTION_MS) throw new Error('Entri asal untuk reply sudah kedaluwarsa')
  return chat
}

// Bangun objek quoted untuk balasan mode 'reply' dari entri asal: balasan
// Ryn meng-quote pesan pemicunya (permintaan founder). Hanya memakai data
// yang bot catat sendiri (msgId, chat, pengirim, teks asli pesan). Entri
// tanpa msgId -> null (balasan dikirim tanpa quote).
export function buildReplyQuote(entry) {
  if (!entry || typeof entry !== 'object' || !entry.msgId || typeof entry.chat !== 'string') return null
  const key = { id: String(entry.msgId), remoteJid: entry.chat, fromMe: false }
  if (entry.chat.endsWith('@g.us') && typeof entry.from === 'string' && entry.from) key.participant = entry.from
  return { key, message: { conversation: String(entry.origText ?? entry.text ?? '').slice(0, 1000) } }
}

export function validateJob(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Job harus objek JSON')
  if (!BRIDGE_TYPES.has(raw.type)) throw new Error("type harus 'say', 'cmd', 'file', atau 'reply'")
  if (raw.type === 'reply') {
    if (typeof raw.ref !== 'string' || !REPLY_REF_RE.test(raw.ref)) throw new Error('ref wajib berupa id entri to-ryn')
    if (typeof raw.text !== 'string' || !raw.text.trim()) throw new Error('text wajib diisi')
    if (raw.text.length > MAX_TEXT) throw new Error(`text maksimal ${MAX_TEXT} karakter`)
    return { type: 'reply', ref: raw.ref, text: raw.text }
  }
  if (raw.type === 'file') {
    if (typeof raw.path !== 'string' || !raw.path.trim()) throw new Error('path wajib diisi untuk job file')
    if (raw.path.length > 500) throw new Error('path maksimal 500 karakter')
    const caption = typeof raw.caption === 'string' ? raw.caption : ''
    if (caption.length > 1000) throw new Error('caption maksimal 1000 karakter')
    return { type: 'file', path: raw.path, caption }
  }
  if (typeof raw.text !== 'string' || !raw.text.trim()) throw new Error('text wajib diisi')
  if (raw.text.length > MAX_TEXT) throw new Error(`text maksimal ${MAX_TEXT} karakter`)
  return { type: raw.type, text: raw.text }
}

export function buildSyntheticMessage({ ownerJid, text, nowMs = Date.now(), id }) {
  return {
    key: { remoteJid: ownerJid, fromMe: false, id },
    message: { conversation: text },
    messageTimestamp: Math.floor(nowMs / 1000),
  }
}

function extFor(kind, mimetype = '') {
  const mime = String(mimetype).toLowerCase()
  if (mime.includes('png')) return 'png'
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('pdf')) return 'pdf'
  return { sticker: 'webp', image: 'jpg', video: 'mp4', audio: 'ogg', document: 'bin' }[kind] ?? 'bin'
}

// Ringkas satu payload sendMessage menjadi catatan audit. Buffer media tidak
// masuk JSON — disimpan sebagai file lewat saveMedia (bila disediakan).
export async function summarizeContent(content, saveMedia) {
  if (!content || typeof content !== 'object') return { kind: 'empty' }
  if (content.react) return { kind: 'react', emoji: content.react.text ?? '' }
  for (const kind of ['sticker', 'image', 'video', 'document', 'audio']) {
    const data = content[kind]
    if (!data) continue
    const entry = { kind, mimetype: String(content.mimetype || data?.mimetype || '') }
    entry.ext = extFor(kind, entry.mimetype)
    if (content.caption) entry.caption = String(content.caption).slice(0, 1000)
    if (content.fileName) entry.fileName = String(content.fileName).slice(0, 200)
    const buf = Buffer.isBuffer(data) ? data : data instanceof Uint8Array ? Buffer.from(data) : null
    if (buf) {
      entry.bytes = buf.length
      entry.source = 'buffer'
      if (saveMedia) {
        if (buf.length > BRIDGE_MAX_MEDIA_BYTES) entry.fileOmitted = 'too-large'
        else { const name = await saveMedia(kind, buf, entry.mimetype); if (name) entry.file = name; else entry.fileOmitted = 'media-cap' }
      }
    } else if (data && typeof data === 'object') {
      entry.source = typeof data.url === 'string' ? 'url' : 'stream'
    }
    return entry
  }
  if (typeof content.text === 'string') return { kind: 'text', text: content.text.slice(0, 4000) }
  return { kind: Object.keys(content)[0] ?? 'unknown' }
}

// Bungkus conn.sendMessage selama satu job: semua kiriman ke ownerJid dicatat.
// Mengembalikan fungsi restore yang mengembalikan descriptor asli persis.
function wrapSend(conn, onSend) {
  const descriptor = Object.getOwnPropertyDescriptor(conn, 'sendMessage')
  const original = conn.sendMessage
  const wrapped = async function (jid, content, options) {
    const result = await original.call(conn, jid, content, options)
    try { await onSend(jid, content) } catch (e) { printError(e, { module: 'localBridge', stage: 'capture' }) }
    return result
  }
  Object.defineProperty(conn, 'sendMessage', { value: wrapped, configurable: true, writable: true })
  return () => { if (descriptor) Object.defineProperty(conn, 'sendMessage', descriptor); else delete conn.sendMessage }
}

export function createLocalBridge({ root, getConn, isOpen, config = globalThis, pollMs = 1000 } = {}) {
  const baseDir = path.join(root, 'src', 'private', 'bridge')
  const inboxDir = path.join(baseDir, 'inbox')
  const outboxDir = path.join(baseDir, 'outbox')
  let timer = null, busy = false, stopped = false, lastCleanupAt = 0

  // Sapu berkala outbox: file berumur melewati retensi dihapus, jumlah hasil
  // dibatasi job terbaru (media terhapus bersama job-nya), dan sisa .tmp
  // yatim di inbox (job gagal tertulis) ikut dibuang. File job .json di
  // inbox tidak disentuh — itu antrean, bukan sampah.
  async function cleanup(now = Date.now()) {
    lastCleanupAt = now
    const cutoff = now - BRIDGE_RETENTION_MS
    let names = []
    try { names = await fsp.readdir(outboxDir) } catch { /* folder belum ada */ }
    const results = []
    for (const name of names) {
      const file = path.join(outboxDir, name)
      const stat = await fsp.stat(file).catch(() => null)
      if (!stat?.isFile()) continue
      if (stat.mtimeMs < cutoff) { await fsp.unlink(file).catch(() => {}); continue }
      if (FILE_RE.test(name)) results.push({ id: name.slice(0, -'.json'.length), mtimeMs: stat.mtimeMs })
    }
    if (results.length > BRIDGE_MAX_OUTBOX_JOBS) {
      results.sort((a, b) => b.mtimeMs - a.mtimeMs)
      for (const old of results.slice(BRIDGE_MAX_OUTBOX_JOBS)) {
        await fsp.unlink(path.join(outboxDir, `${old.id}.json`)).catch(() => {})
        for (const name of names) if (name.startsWith(`${old.id}-`)) await fsp.unlink(path.join(outboxDir, name)).catch(() => {})
      }
    }
    let inboxNames = []
    try { inboxNames = await fsp.readdir(inboxDir) } catch { /* folder belum ada */ }
    for (const name of inboxNames) {
      if (FILE_RE.test(name)) continue
      const stat = await fsp.stat(path.join(inboxDir, name)).catch(() => null)
      if (stat?.isFile() && stat.mtimeMs < now - CLEANUP_INTERVAL_MS) await fsp.unlink(path.join(inboxDir, name)).catch(() => {})
    }
  }

  async function writeResult(id, result) {
    const tmp = path.join(outboxDir, `.${id}.tmp`)
    await fsp.writeFile(tmp, JSON.stringify(result, null, 2))
    await fsp.rename(tmp, path.join(outboxDir, `${id}.json`))
  }

  async function runJob(id, job) {
    const conn = getConn()
    const ownerJid = ownerJidOf(config)
    if (!conn) throw new Error('Socket bot belum tersedia')
    if (!ownerJid) throw new Error('Nomor founder tidak ditemukan di config')
    const replies = []
    const ownerLid = String(config.founder?.[0]?.[1] ?? '').replace(/\D/g, '')
    const ownerLidJid = ownerLid ? `${ownerLid}@lid` : null
    const isOwnerTarget = jid => jid === ownerJid || (ownerLidJid !== null && jid === ownerLidJid) || (() => { try { return !!conn.identity?.same?.(jid, ownerJid) } catch { return false } })()
    // Mode reply: alamat tujuan dibaca dari catatan to-ryn yang ditulis bot
    // sendiri (bukan dari job) — lihat replyTargetOf. Entri yang sama juga
    // jadi bahan quote balasan (buildReplyQuote).
    let targetChat = ownerJid
    let replyEntry = null
    if (job.type === 'reply') {
      try { replyEntry = JSON.parse(await fsp.readFile(path.join(baseDir, 'to-ryn', `${job.ref}.json`), 'utf8')) } catch { replyEntry = null }
      targetChat = replyTargetOf(replyEntry)
    }
    const isCaptureTarget = jid => job.type === 'reply' ? jid === targetChat : isOwnerTarget(jid)
    let mediaCount = 0, lastSendAt = 0
    const saveMedia = async (kind, buf, mimetype) => {
      if (buf.length > BRIDGE_MAX_MEDIA_BYTES || mediaCount >= MAX_MEDIA_FILES) return null
      mediaCount++
      const name = `${id}-${mediaCount}.${extFor(kind, mimetype)}`
      await fsp.writeFile(path.join(outboxDir, name), buf)
      return name
    }
    const restore = wrapSend(conn, async (jid, content) => {
      if (!isCaptureTarget(jid) || replies.length >= MAX_REPLIES) return
      lastSendAt = Date.now()
      const entry = await summarizeContent(content, saveMedia)
      entry.chat = jid
      entry.ts = new Date().toISOString()
      replies.push(entry)
    })
    const startedAt = new Date().toISOString()
    try {
      if (job.type === 'reply') {
        const quote = buildReplyQuote(replyEntry)
        await conn.sendMessage(targetChat, { text: job.text }, quote ? { quoted: quote } : undefined)
      } else if (job.type === 'say') {
        await conn.sendMessage(ownerJid, { text: job.text })
      } else if (job.type === 'file') {
        if (typeof conn.sendFile !== 'function') throw new Error('Socket bot tidak mendukung kirim file')
        const abs = resolveBridgeFile(root, job.path)
        const stat = await fsp.stat(abs).catch(() => null)
        if (!stat?.isFile()) throw new Error(`File tidak ditemukan: ${job.path}`)
        if (stat.size > BRIDGE_SEND_MAX_BYTES) throw new Error(`File melewati plafon kirim WA (${BRIDGE_SEND_MAX_BYTES} byte)`)
        await conn.sendFile(ownerJid, abs, path.basename(abs), job.caption || '')
      } else {
        await conn.sendMessage(ownerJid, { text: `🧪 [tes Ryn] ${job.text}` })
        const raw = buildSyntheticMessage({ ownerJid, text: job.text, id: 'RYN' + crypto.randomBytes(8).toString('hex').toUpperCase() })
        await conn.pipeline.handler.call(conn, { type: 'notify', messages: [raw] })
        if (!lastSendAt) lastSendAt = Date.now()
        const deadline = Date.now() + GRACE_MAX_MS
        while (Date.now() < deadline && Date.now() - lastSendAt < QUIET_MS) await sleep(200)
      }
    } finally { restore() }
    return { id, ok: true, type: job.type, ...(job.type === 'file' ? { path: job.path } : job.type === 'reply' ? { ref: job.ref, chat: targetChat, text: job.text } : { text: job.text }), startedAt, finishedAt: new Date().toISOString(), replies }
  }

  async function processFile(name) {
    const id = name.slice(0, -'.json'.length)
    const file = path.join(inboxDir, name)
    const done = () => fsp.unlink(file).catch(() => {})
    if (fs.existsSync(path.join(outboxDir, `${id}.json`))) { await done(); return }
    let job
    try {
      const stat = await fsp.stat(file)
      if (stat.size > MAX_JOB_BYTES) throw new Error('File job terlalu besar')
      job = validateJob(JSON.parse(await fsp.readFile(file, 'utf8')))
    } catch (e) {
      await writeResult(id, { id, ok: false, error: String(e?.message ?? e).slice(0, 500), finishedAt: new Date().toISOString() }).catch(() => {})
      await done(); return
    }
    try {
      await writeResult(id, await runJob(id, job))
      logger.info(`[bridge] job ${id} (${job.type}) selesai`)
    } catch (e) {
      printError(e, { module: 'localBridge', stage: 'run', id })
      await writeResult(id, { id, ok: false, type: job.type, ...(job.type === 'file' ? { path: job.path } : { text: job.text }), error: String(e?.message ?? e).slice(0, 500), finishedAt: new Date().toISOString() }).catch(() => {})
    }
    await done()
  }

  async function tick() {
    if (stopped || busy) return
    if (Date.now() - lastCleanupAt > CLEANUP_INTERVAL_MS) await cleanup().catch(() => {})
    if (config.bridge !== true) return
    const conn = getConn()
    if (!conn || !isOpen()) return
    let names
    try { names = await fsp.readdir(inboxDir) } catch { return }
    const next = names.filter(n => FILE_RE.test(n)).sort()[0]
    if (!next) return
    busy = true
    try { await processFile(next) } catch (e) { printError(e, { module: 'localBridge', stage: 'tick' }) } finally { busy = false }
  }

  return {
    dirs: { inboxDir, outboxDir },
    cleanupNow: cleanup,
    async start() {
      await fsp.mkdir(inboxDir, { recursive: true })
      await fsp.mkdir(outboxDir, { recursive: true })
      await cleanup().catch(() => {})
      if (!timer) { timer = setInterval(() => { tick().catch(() => {}) }, pollMs); timer.unref?.() }
      logger.info('[bridge] jembatan lokal Ryn siap (saklar: .config set bridge on/off)')
    },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null },
  }
}
