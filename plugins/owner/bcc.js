// plugins/owner/bcc.js
//
// .bcc — broadcast ke saluran WhatsApp (tujuan dari .config botChannel).
//   .bcc <teks>                  kirim teks ke saluran
//   .bcc (kirim gambar)          kirim gambar + caption-nya ke saluran
//   .bcc (reply gambar)          kirim gambar yang di-reply + caption-nya
//   .bcc <teks> (reply gambar ber-caption) -> KONFLIK: bot bertanya dulu,
//     jawab angka biasa (tanpa reply, handler.before):
//       1 = teks direct, 2 = teks reply, 3 = gabung
//     kalau gabung, pilih lagi urutannya:
//       1 = direct di atas, reply di bawah; 2 = sebaliknya
//     'batal' menutup sesi (sesi kedaluwarsa 5 menit).
//
// Aturan isi:
//   - Media = gambar sendiri (dikirim bersama perintah) bila ada, kalau
//     tidak gambar yang di-reply. Video dan media lain tidak dibawa —
//     caption/teksnya saja yang dihitung sebagai teks reply.
//   - Satu sumber teks saja langsung disiarkan tanpa tanya; dua sumber
//     teks membuka sesi tanya; tanpa teks tapi ada gambar, gambar saja
//     yang disiarkan (tanpa caption).
//   - Caption gambar WA mentok 1024 karakter: caption gabungan yang
//     lebih panjang dikirim sebagai gambar polos + pesan teks terpisah,
//     supaya tidak ada yang terpotong diam-diam.
// Founder-only: saluran itu milik founder, jadi hanya founder yang boleh
// menyiarkan. Tanpa botChannel yang diatur, perintah ditolak jelas
// (bukan disiarkan ke tempat yang salah).

import { reactTo, REACT } from '#lib/helpers/react.js'
import { bccSessions, decideBcc, combineBccTexts, previewBcc, resolveBccTarget, BCC_CAPTION_LIMIT } from '#lib/helpers/bccSession.js'

const CHANNEL_HINT = 'Saluran belum diatur — founder bisa mengatur: .config set botChannel 120363xxx@newsletter'
const USAGE = 'Kirim pesannya: .bcc <teks> — atau kirim/reply gambar (caption-nya jadi isi broadcast).'

// Unduh gambar dari pesan serial (sendiri / quoted). null = bukan gambar.
async function downloadImage(msg) {
  if (!msg || msg.mtype !== 'imageMessage') return null
  const buffer = await msg.download()
  if (!buffer?.length) throw 'Medianya gagal diunduh — coba kirim ulang ya.'
  return { buffer, mimetype: msg.msg?.mimetype || 'image/jpeg' }
}

// Satu-satunya jalur kirim ke saluran (dipakai perintah + hook pilih).
// Baileys menangani JID @newsletter lewat sendMessage biasa.
async function sendBcc(conn, channel, { text = '', media = null }) {
  const caption = String(text ?? '')
  if (media) {
    if (caption.length > BCC_CAPTION_LIMIT) {
      await conn.sendMessage(channel, { image: media.buffer, mimetype: media.mimetype })
      if (caption) await conn.sendMessage(channel, { text: caption })
      return
    }
    await conn.sendMessage(channel, { image: media.buffer, mimetype: media.mimetype, caption })
    return
  }
  await conn.sendMessage(channel, { text: caption })
}

let handler = async (m, ctx) => {
  const conn = ctx?.conn ?? m.conn
  const channel = resolveBccTarget()
  if (!channel) throw CHANNEL_HINT
  const directText = String(ctx.text ?? '').trim()
  const ownImage = m.mtype === 'imageMessage' ? m : null
  const q = m.quoted
  const quotedImage = q?.mtype === 'imageMessage' ? q : null
  const replyText = String(q?.caption ?? q?.text ?? '').trim()
  const decision = decideBcc({ directText, replyText })
  const mediaMsg = ownImage ?? quotedImage
  if (decision.kind === 'empty' && !mediaMsg) throw USAGE
  if (decision.kind === 'conflict') {
    // Belum ada yang disiarkan: tahan media di sesi, tanya dulu.
    // Sengaja tanpa react ⏳ di pesan perintah — ✅ baru ditempel di
    // pesan jawaban saat siaran benar-benar terkirim.
    const media = mediaMsg ? await downloadImage(mediaMsg) : null
    const store = ctx?.bccSessions ?? bccSessions
    store.put(m.chat, m.sender, { step: 'choose', directText: decision.directText, replyText: decision.replyText, media })
    await m.reply(
      'Ada 2 teks yang bertentangan, mau pakai yang mana?\n' +
      `• Direct: ${previewBcc(decision.directText)}\n` +
      `• Reply: ${previewBcc(decision.replyText)}\n` +
      (media ? '🖼️ Gambar ikut terkirim.\n' : '') +
      '\nJawab angka biasa (tanpa reply):\n' +
      '1. Direct text\n' +
      '2. Reply\n' +
      '3. Gabung\n' +
      'atau *batal* buat tutup sesi.'
    )
    return
  }
  await reactTo(m, REACT.processing, { conn }).catch(() => {})
  const media = mediaMsg ? await downloadImage(mediaMsg) : null
  await sendBcc(conn, channel, { text: decision.text, media })
  await reactTo(m, REACT.done, { conn }).catch(() => {})
  await m.reply('Broadcast terkirim ke saluran.')
}

handler.help = ['bcc <pesan>', 'bcc (kirim/reply gambar)']
handler.tags = ['owner']
handler.command = ['bcc', 'broadcastchannel']
handler.founder = true

// Hook pilih angka untuk sesi .bcc. Hanya token persis yang ditelan
// (angka dalam rentang, batal); pesan lain — termasuk perintah baru —
// dibiarkan lewat (return false) supaya tidak mengganggu obrolan atau
// perintah lain. Return true hanya menelan pesan itu dari handler .bcc
// sendiri; konsumsi sesungguhnya terjadi lewat efek samping di sini.
handler.before = async (m, ctx) => {
  try {
    if (m.fromMe) return false
    const text = String(m.text ?? '').trim()
    if (!text) return false
    const lower = text.toLowerCase()
    const store = ctx?.bccSessions ?? bccSessions
    const session = store.get(m.chat, m.sender)
    if (!session) return false
    const conn = ctx?.conn ?? m.conn

    // Siaran penutup sesi: target dibaca segar (bukan dari sesi) agar
    // perubahan .config botChannel di tengah sesi langsung berlaku.
    const finish = async payload => {
      const channel = resolveBccTarget()
      if (!channel) {
        store.delete(m.chat, m.sender)
        await m.reply(CHANNEL_HINT)
        return true
      }
      try {
        await sendBcc(conn, channel, payload)
        await reactTo(m, REACT.done, { conn }).catch(() => {})
        await m.reply('Broadcast terkirim ke saluran.')
      } catch (e) {
        await m.reply(`❌ Broadcast gagal: ${e?.message ?? e}`)
      }
      store.delete(m.chat, m.sender)
      return true
    }

    if (lower === 'batal') {
      store.delete(m.chat, m.sender)
      await m.reply('Sesi .bcc ditutup.')
      return true
    }
    if (!/^\d+$/.test(text)) return false
    const n = Number(text)
    if (session.step === 'choose') {
      if (n === 1) return finish({ text: session.directText, media: session.media })
      if (n === 2) return finish({ text: session.replyText, media: session.media })
      if (n === 3) {
        store.put(m.chat, m.sender, { ...session, step: 'order' })
        await m.reply(
          'Gabung teksnya, mana di atas?\n' +
          '1. Direct di atas, reply di bawah\n' +
          '2. Reply di atas, direct di bawah\n' +
          'atau *batal* buat tutup sesi.'
        )
        return true
      }
      await m.reply('Pilih 1–3, atau *batal* buat tutup sesi.')
      return true
    }
    // step === 'order'
    if (n === 1) return finish({ text: combineBccTexts(session.directText, session.replyText, 'direct-first'), media: session.media })
    if (n === 2) return finish({ text: combineBccTexts(session.directText, session.replyText, 'reply-first'), media: session.media })
    await m.reply('Pilih 1–2, atau *batal* buat tutup sesi.')
    return true
  } catch { return false }
}

export default handler
