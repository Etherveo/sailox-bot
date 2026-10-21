// lib/helpers/kdriveRelay.js
//
// Jembatan relay kDrive ANTAR-DUA-BOT independen (bukan jadibot — sub-bot
// berjalan di server yang sama dengan bot utama, jadi tidak memberi
// pemisahan geografis apa pun):
//
//   Bot ASING (panel di luar whitelist, .config kdriveMode stranger)
//     -- pesan WhatsApp "KDR1 REQ ..." -->
//   Bot RESOLVER (server ter-whitelist, mode direct)
//     -- resolusi lokal (lib/kuramanime/resolve.js) -->
//     -- pesan WhatsApp "KDR1 OK ..." berisi URL endpoint bertanda tangan
//   Bot ASING mengunduh file-nya LANGSUNG dari endpoint (terbukti bisa
//   di-fetch biasa dari server asing) — berkas berat tidak pernah lewat
//   bot resolver; yang menyeberang cuma teks URL.
//
// Protokol v1 (satu pesan teks, spasi sebagai pemisah; URL tidak pernah
// mengandung spasi):
//   KDR1 REQ  <reqId> <tokenB64|-> <urlPembungkus> <urlEpisode|->
//   KDR1 PING <reqId> <tokenB64|->
//   KDR1 OK   <reqId> <urlEndpoint> <size|-> <namaFileB64|->
//   KDR1 ERR  <reqId> <pesan bebas satu baris>
//   KDR1 PONG <reqId>
//
// Keamanan: kedua sisi memasang nomor pasangan di global.kdrivePeer
// (diatur founder via .config set kdrivePeer <nomor>) — resolver HANYA
// melayani pengirim itu, di chat pribadi, dan diam total terhadap yang
// lain. Bila global.kdriveRelayToken terisi (di config.js, BUKAN dari
// chat), token di pesan wajib cocok; tidak cocok = diabaikan diam-diam.
// URL endpoint hasil resolusi sifatnya bearer (siapa pun pemegangnya bisa
// mengunduh) — memang begitu desain tanda tangannya dari Kuramanime.

import { randomBytes } from 'node:crypto'
import { resolveKdrive } from '../kuramanime/resolve.js'

export const RELAY_PREFIX = 'KDR1'
export const DEFAULT_RELAY_TIMEOUT_MS = 120_000
const MAX_CONCURRENT_RESOLUTIONS = 2

const b64enc = text => Buffer.from(String(text), 'utf8').toString('base64url')
const b64dec = text => {
  try { return Buffer.from(String(text), 'base64url').toString('utf8') } catch { return '' }
}

export const digitsOf = value => String(value ?? '').replace(/\D/g, '')

export function isKdriveWrapperUrl(url = '') {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    return (host === 'kuramadrive.com' || host.endsWith('.kuramadrive.com')) &&
      /\/(kdrive|kturbo)\/[^/?#]+/i.test(new URL(String(url)).pathname)
  } catch { return false }
}

export function relayPeer(config = globalThis) { return digitsOf(config.kdrivePeer) }
export function relayToken(config = globalThis) { return String(config.kdriveRelayToken ?? '').trim() }

function newReqId() { return randomBytes(4).toString('hex') }

export function formatRequest(reqId, { token = '', url, episodeUrl } = {}) {
  return [RELAY_PREFIX, 'REQ', reqId, token ? b64enc(token) : '-', url, episodeUrl || '-'].join(' ')
}
export function formatPing(reqId, { token = '' } = {}) {
  return [RELAY_PREFIX, 'PING', reqId, token ? b64enc(token) : '-'].join(' ')
}
export function formatOk(reqId, { fileUrl, size, fileName } = {}) {
  return [RELAY_PREFIX, 'OK', reqId, fileUrl, size ?? '-', fileName ? b64enc(fileName) : '-'].join(' ')
}
export function formatErr(reqId, message) {
  const clean = String(message ?? 'error').replace(/\s+/g, ' ').slice(0, 300)
  return [RELAY_PREFIX, 'ERR', reqId, clean].join(' ')
}
export function formatPong(reqId) { return [RELAY_PREFIX, 'PONG', reqId].join(' ') }

export function parseRelayMessage(text = '') {
  const parts = String(text).trim().split(/\s+/)
  if (parts[0] !== RELAY_PREFIX) return null
  const kind = parts[1]
  const reqId = parts[2]
  if (!reqId) return null
  switch (kind) {
    case 'REQ': {
      if (!parts[4]) return null
      return { kind, reqId, token: parts[3] === '-' ? '' : b64dec(parts[3]), url: parts[4], episodeUrl: parts[5] && parts[5] !== '-' ? parts[5] : undefined }
    }
    case 'PING':
      return { kind, reqId, token: parts[3] === '-' || parts[3] === undefined ? '' : b64dec(parts[3]) }
    case 'OK': {
      if (!parts[3]) return null
      return { kind, reqId, fileUrl: parts[3], size: parts[4] && parts[4] !== '-' ? Number(parts[4]) : null, fileName: parts[5] && parts[5] !== '-' ? b64dec(parts[5]) : '' }
    }
    case 'ERR':
      return { kind, reqId, message: parts.slice(3).join(' ') || 'error dari resolver' }
    case 'PONG':
      return { kind, reqId }
    default:
      return null
  }
}

// ─── Sisi klien (bot asing / penanya) ────────────────────────────────────────

const pending = new Map()

function waitFor(reqId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId)
      reject(new Error(`Relay timeout (${Math.round(timeoutMs / 1000)} detik) — bot pasangan tidak menjawab. Cek: bot resolver hidup, nomor kdrivePeer di kedua sisi sudah saling terpasang, dan token relay sama.`))
    }, timeoutMs)
    pending.set(reqId, { resolve, reject, timer })
  })
}

function settle(parsed) {
  const waiter = pending.get(parsed.reqId)
  if (!waiter) return false
  pending.delete(parsed.reqId)
  clearTimeout(waiter.timer)
  if (parsed.kind === 'ERR') waiter.reject(new Error(parsed.message))
  else waiter.resolve(parsed)
  return true
}

export function pendingCount() { return pending.size }

async function ask(conn, text, reqId, { peer, timeoutMs }) {
  const promise = waitFor(reqId, timeoutMs)
  try {
    await conn.sendMessage(`${peer}@s.whatsapp.net`, { text })
  } catch (e) {
    const waiter = pending.get(reqId)
    if (waiter) { pending.delete(reqId); clearTimeout(waiter.timer) }
    throw new Error(`Gagal mengirim request relay ke bot pasangan: ${e.message}`)
  }
  return promise
}

/** Minta bot pasangan me-resolusi URL pembungkus kDrive. */
export async function requestResolution(conn, { url, episodeUrl, timeoutMs = DEFAULT_RELAY_TIMEOUT_MS, config = globalThis } = {}) {
  const peer = relayPeer(config)
  if (!peer) throw new Error('kdrivePeer belum terpasang — atur nomor bot resolver lewat .config set kdrivePeer <nomor>.')
  const reqId = newReqId()
  const parsed = await ask(conn, formatRequest(reqId, { token: relayToken(config), url, episodeUrl }), reqId, { peer, timeoutMs })
  return { fileUrl: parsed.fileUrl, size: parsed.size, fileName: parsed.fileName }
}

/** Tes pasangan: kirim PING, tunggu PONG. Mengembalikan latensi ms. */
export async function requestPing(conn, { timeoutMs = 30_000, config = globalThis } = {}) {
  const peer = relayPeer(config)
  if (!peer) throw new Error('kdrivePeer belum terpasang — atur nomor bot pasangan lewat .config set kdrivePeer <nomor>.')
  const reqId = newReqId()
  const started = Date.now()
  await ask(conn, formatPing(reqId, { token: relayToken(config) }), reqId, { peer, timeoutMs })
  return Date.now() - started
}

// ─── Sisi resolver (bot ter-whitelist / penjawab) ────────────────────────────

let activeResolutions = 0

function senderDigitsCandidates(m) {
  return [m.sender, m.senderJid, m.chat].map(digitsOf).filter(Boolean)
}

/**
 * Tangani satu pesan masuk: selesaikan waiter klien (OK/ERR/PONG dari
 * pasangan) atau layani request pasangan (REQ/PING). Mengembalikan true
 * bila pesan adalah pesan relay yang ditangani/diabaikan secara sadar.
 * deps.resolve bisa diinjeksi untuk tes.
 */
export async function handleRelayIncoming(conn, m, { config = globalThis, resolve = resolveKdrive } = {}) {
  const parsed = parseRelayMessage(m?.text ?? '')
  if (!parsed) return false

  const peer = relayPeer(config)
  if (!peer) return false // relay belum dipasangkan — abaikan diam-diam

  const fromPeer = senderDigitsCandidates(m).includes(peer)

  if (parsed.kind === 'OK' || parsed.kind === 'ERR' || parsed.kind === 'PONG') {
    return fromPeer ? settle(parsed) : false
  }

  // REQ / PING: hanya dari pasangan, chat pribadi, bukan pesan sendiri.
  if (!fromPeer || m.fromMe || m.isGroup) return false

  const expectedToken = relayToken(config)
  if (expectedToken && parsed.token !== expectedToken) return false // diam: token salah

  if (parsed.kind === 'PING') {
    await conn.sendMessage(m.chat, { text: formatPong(parsed.reqId) })
    return true
  }

  // REQ
  if (config.kdriveMode === 'stranger') {
    await conn.sendMessage(m.chat, { text: formatErr(parsed.reqId, 'Bot ini mode stranger — bukan resolver. Pasang resolver di bot yang ter-whitelist.') })
    return true
  }
  if (activeResolutions >= MAX_CONCURRENT_RESOLUTIONS) {
    await conn.sendMessage(m.chat, { text: formatErr(parsed.reqId, 'Resolver sedang sibuk, coba lagi sebentar.') })
    return true
  }
  activeResolutions++
  try {
    const info = await resolve(parsed.url, { episodeUrl: parsed.episodeUrl })
    await conn.sendMessage(m.chat, { text: formatOk(parsed.reqId, info) })
  } catch (e) {
    await conn.sendMessage(m.chat, { text: formatErr(parsed.reqId, e.message || String(e)) })
  } finally {
    activeResolutions--
  }
  return true
}
