import path from 'node:path'
import { reactTo, REACT } from '#lib/helpers/react.js'
import { createRynChat, parseRynArgs, parseNameCall, shouldForward, scopeAllows, userAllowed, detectRynTrigger, RYN_MAX_TEXT } from '#lib/helpers/rynChat.js'

// Chat dua arah pengguna <-> Ryn lewat WhatsApp (jembatan lokal, lihat
// lib/helpers/rynChat.js dan lib/helpers/localBridge.js):
//   .ryn <teks>          kirim satu pesan bebas ke Ryn (sekali jalan)
//   .ryn --on [teks]     nyalakan mode percakapan di chat ini; teks
//                        sebelum/sesudah flag jadi input awal; tanpa teks,
//                        Ryn yang menyapa duluan
//   .ryn --off           matikan mode percakapan chat ini
// Selama mode menyala, handler.before meneruskan teks biasa PEMBUKA sesi
// (bukan perintah, bukan media) ke Ryn; sesi per chat, mati otomatis
// setelah 5 menit senyap. Di luar mode, handler.before mengenali trigger
// sekali jalan (urutan: nama > reply > mention): pesan diawali "Ryn, ...",
// pesan yang me-reply pesan bot, atau pesan yang men-mention bot — dua
// yang terakhir bisa dimatikan lewat .config rynTriggerReply /
// rynTriggerMention. Semua penyaringan terjadi di sisi bot ini: pesan di
// luar ketentuan tidak pernah masuk antrean to-ryn.
//
// Jangkauan diatur founder lewat .config (digerbang juga saklar bridge):
//   rynScope  private (DM founder saja) | group | both
//   rynUsers  di grup: founder | anyone   (DM selalu founder-only)
//   rynGroups allowlist JID grup; kosong = semua grup
// Balasan Ryn kembali ke chat asal lewat bridge mode 'reply'.

let rynChat = null
function chatFor(ctx) {
  if (!rynChat) rynChat = createRynChat({ root: path.resolve(ctx.__dirname, '..', '..') })
  return rynChat
}

const scopeOf = () => ['private', 'group', 'both'].includes(globalThis.rynScope) ? globalThis.rynScope : 'private'
const usersOf = () => ['founder', 'anyone'].includes(globalThis.rynUsers) ? globalThis.rynUsers : 'anyone'
const groupsOf = () => Array.isArray(globalThis.rynGroups) ? globalThis.rynGroups : []
const chatAllowed = (chat, isGroup) => !isGroup || groupsOf().length === 0 || groupsOf().includes(chat)
const sameUser = ctx => (a, b) => { try { return !!ctx.conn?.identity?.same?.(a, b) } catch { return a === b } }
const meta = m => ({ from: m.sender ?? null, senderName: m.pushName ?? null, isGroup: !!m.isGroup, origText: String(m.text ?? '').slice(0, 1000) })
// Apakah pesan ini men-tag bot? mentionedJid pesan dicocokkan ke semua
// identitas bot sendiri (PN + LID) lewat resolver identitas koneksi.
const mentionsBot = (m, ctx) => {
  const list = Array.isArray(m.mentionedJid) ? m.mentionedJid : []
  if (!list.length) return false
  const selfIds = ctx.conn?.identity?.self ?? []
  return list.some(j => selfIds.some(s => { try { return !!ctx.conn?.identity?.same?.(s, j) } catch { return s === j } }))
}

// Konteks pesan yang di-reply pengirim (kalau ada): teks/caption-nya
// (dipotong), siapa penulisnya, dan apakah itu pesan bot sendiri — supaya
// Ryn tahu pesan mana yang sedang ditunjuk ("ini maksudnya apa?").
// Media tanpa caption hanya tercatat tipenya; isinya tidak diteruskan.
const quotedMeta = m => {
  const q = m.quoted
  if (!q) return null
  const text = String(q.text ?? '').trim()
  return { text: text.slice(0, 1000), sender: q.sender ?? null, fromBot: !!q.fromMe, mtype: q.mtype ?? null }
}

function gate(m, ctx) {
  if (!scopeAllows(scopeOf(), !!m.isGroup)) return m.isGroup ? 'Chat Ryn belum aktif di grup — founder bisa mengaktifkan: .config set rynScope both' : 'Chat Ryn lagi khusus grup — founder bisa mengubah: .config set rynScope both'
  if (!chatAllowed(m.chat, !!m.isGroup)) return 'Grup ini belum diizinkan memakai chat Ryn (rynGroups).'
  if (!userAllowed({ isGroup: !!m.isGroup, isFounder: !!ctx.isFounder, users: usersOf() })) return m.isGroup ? 'Di grup ini chat Ryn khusus founder.' : 'Chat Ryn khusus founder.'
  return null
}

let handler = async (m, ctx) => {
  if (globalThis.bridge !== true) throw 'Jembatan Ryn lagi OFF — nyalakan dulu: .config set bridge on'
  const denied = gate(m, ctx)
  if (denied) throw denied
  const rc = chatFor(ctx)
  const { flag, input } = parseRynArgs(ctx.text ?? '')
  if (flag === 'off') {
    const state = await rc.readSession()
    const entry = state.sessions?.[m.chat]
    if (entry?.active && entry.by && !ctx.isFounder && !sameUser(ctx)(entry.by, m.sender)) throw 'Sesi Ryn di chat ini bukan punya kamu — cuma pembukanya (atau founder) yang bisa mematikan.'
    await rc.endSession(m.chat)
    await reactTo(m, REACT.bye)
    return
  }
  if (flag === 'on') {
    await rc.startSession(m.chat, { by: m.sender })
    await reactTo(m, REACT.chat)
    if (input) await rc.enqueue({ type: 'message', mode: 'session', text: input.slice(0, RYN_MAX_TEXT), msgId: m.id, chat: m.chat, ...meta(m), quoted: quotedMeta(m) })
    else await rc.enqueue({ type: 'session-start', mode: 'session', msgId: m.id, chat: m.chat, ...meta(m) })
    return
  }
  if (!input) throw 'Tulis pesannya sekalian: .ryn <teks> — atau .ryn --on buat mode percakapan, .ryn --off buat berhenti.'
  await reactTo(m, REACT.processing)
  await rc.enqueue({ type: 'message', mode: 'once', text: input.slice(0, RYN_MAX_TEXT), msgId: m.id, chat: m.chat, ...meta(m), quoted: quotedMeta(m) })
}

handler.help = ['ryn <teks>', 'ryn --on [teks]', 'ryn --off']
handler.tags = ['owner']
handler.command = ['ryn']

// Mode percakapan + trigger nama. Berjalan untuk semua pesan (hook before
// pipeline), tapi keputusan meneruskan diserahkan ke shouldForward yang
// ketat (scope config + allowlist + hak pengirim); selalu kembalikan
// false supaya plugin lain tetap memproses pesan seperti biasa. Urutan:
// sesi aktif di chat ini menelan teks biasa pembukanya; di luar sesi,
// hanya pesan yang diawali panggilan nama "Ryn" yang diteruskan (sekali
// jalan) — sisanya dibiarkan untuk bot.
handler.before = async (m, ctx) => {
  try {
    const candidate = shouldForward({ text: m.text, mtype: m.mtype, isGroup: !!m.isGroup, fromMe: m.fromMe, isFounder: !!ctx.isFounder, bridgeOn: globalThis.bridge === true, scope: scopeOf(), users: usersOf(), chatAllowed: chatAllowed(m.chat, !!m.isGroup) })
    if (!candidate) return false
    const rc = chatFor(ctx)
    if (await rc.sessionActive(m.chat)) {
      const result = await rc.forwardSessionMessage({ text: String(m.text).trim(), msgId: m.id, chat: m.chat, from: m.sender, senderName: m.pushName, quoted: quotedMeta(m), origText: String(m.text ?? ''), sameUser: sameUser(ctx) })
      if (result === 'forwarded') await reactTo(m, REACT.processing).catch(() => {})
      return false
    }
    const call = parseNameCall(m.text)
    const trigger = detectRynTrigger({
      nameInput: call ? call.input : null,
      quotedFromBot: !!m.quoted?.fromMe,
      mentionsBot: mentionsBot(m, ctx),
      replyOn: globalThis.rynTriggerReply !== false,
      mentionOn: globalThis.rynTriggerMention !== false,
    })
    if (!trigger) return false
    if (trigger.via === 'name') {
      if (call.input) await rc.enqueue({ type: 'message', mode: 'once', via: 'name', text: call.input.slice(0, RYN_MAX_TEXT), msgId: m.id, chat: m.chat, ...meta(m), quoted: quotedMeta(m) })
      else await rc.enqueue({ type: 'session-start', mode: 'once', via: 'name', msgId: m.id, chat: m.chat, ...meta(m) })
    } else {
      // Reply-ke-bot / mention: seluruh teks pesan adalah isi panggilan.
      await rc.enqueue({ type: 'message', mode: 'once', via: trigger.via, text: String(m.text).trim().slice(0, RYN_MAX_TEXT), msgId: m.id, chat: m.chat, ...meta(m), quoted: quotedMeta(m) })
    }
    await reactTo(m, REACT.processing).catch(() => {})
    return false
  } catch { return false }
}

export default handler
