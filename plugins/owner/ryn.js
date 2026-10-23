import path from 'node:path'
import { reactTo, REACT } from '#lib/helpers/react.js'
import { createRynChat, parseRynArgs, parseNameCall, shouldForward, RYN_MAX_TEXT } from '#lib/helpers/rynChat.js'

// Chat dua arah founder <-> Ryn lewat WhatsApp (jembatan lokal, lihat
// lib/helpers/rynChat.js dan lib/helpers/localBridge.js):
//   .ryn <teks>          kirim satu pesan bebas ke Ryn (sekali jalan)
//   .ryn --on [teks]     nyalakan mode percakapan; teks sebelum/sesudah flag
//                        jadi input awal; tanpa teks, Ryn yang menyapa duluan
//   .ryn --off           matikan mode percakapan
// Selama mode menyala, handler.before meneruskan teks biasa founder (bukan
// perintah, bukan media) ke Ryn; sesi mati otomatis setelah 5 menit senyap.
// Di luar mode, handler.before juga mengenali trigger panggilan nama: pesan
// yang diawali "Ryn, ..." diteruskan sekali jalan. Semua digerbang saklar
// bridge (.config set bridge on/off) dan founder-only, khusus DM.

let rynChat = null
function chatFor(ctx) {
  if (!rynChat) rynChat = createRynChat({ root: path.resolve(ctx.__dirname, '..', '..') })
  return rynChat
}

let handler = async (m, ctx) => {
  if (globalThis.bridge !== true) throw 'Jembatan Ryn lagi OFF — nyalakan dulu: .config set bridge on'
  const rc = chatFor(ctx)
  const { flag, input } = parseRynArgs(ctx.text ?? '')
  if (flag === 'off') {
    await rc.endSession()
    await reactTo(m, REACT.bye)
    return
  }
  if (flag === 'on') {
    await rc.startSession()
    await reactTo(m, REACT.chat)
    if (input) await rc.enqueue({ type: 'message', mode: 'session', text: input.slice(0, RYN_MAX_TEXT), msgId: m.id, chat: m.chat })
    else await rc.enqueue({ type: 'session-start', mode: 'session', msgId: m.id, chat: m.chat })
    return
  }
  if (!input) throw 'Tulis pesannya sekalian: .ryn <teks> — atau .ryn --on buat mode percakapan, .ryn --off buat berhenti.'
  await reactTo(m, REACT.processing)
  await rc.enqueue({ type: 'message', mode: 'once', text: input.slice(0, RYN_MAX_TEXT), msgId: m.id, chat: m.chat })
}

handler.help = ['ryn <teks>', 'ryn --on [teks]', 'ryn --off']
handler.tags = ['owner']
handler.command = ['ryn']
handler.founder = true
handler.private = true

// Mode percakapan + trigger nama. Berjalan untuk semua pesan (hook before
// pipeline), tapi keputusan meneruskan diserahkan ke shouldForward yang
// ketat; selalu kembalikan false supaya plugin lain tetap memproses pesan
// seperti biasa. Urutan: sesi aktif menelan semua teks biasa; di luar sesi,
// hanya pesan yang diawali panggilan nama "Ryn" yang diteruskan (sekali
// jalan) — sisanya dibiarkan untuk bot.
handler.before = async (m, ctx) => {
  try {
    const candidate = shouldForward({ text: m.text, mtype: m.mtype, isGroup: m.isGroup, fromMe: m.fromMe, isFounder: !!ctx.isFounder, bridgeOn: globalThis.bridge === true })
    if (!candidate) return false
    const rc = chatFor(ctx)
    if (await rc.sessionActive()) {
      const result = await rc.forwardSessionMessage({ text: String(m.text).trim(), msgId: m.id, chat: m.chat })
      if (result === 'forwarded') await reactTo(m, REACT.processing).catch(() => {})
      return false
    }
    const call = parseNameCall(m.text)
    if (!call) return false
    if (call.input) await rc.enqueue({ type: 'message', mode: 'once', via: 'name', text: call.input.slice(0, RYN_MAX_TEXT), msgId: m.id, chat: m.chat })
    else await rc.enqueue({ type: 'session-start', mode: 'once', via: 'name', msgId: m.id, chat: m.chat })
    await reactTo(m, REACT.processing).catch(() => {})
    return false
  } catch { return false }
}

export default handler
