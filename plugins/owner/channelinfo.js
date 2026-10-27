// plugins/owner/channelinfo.js
//
// .channelinfo — ambil ID + metadata saluran WhatsApp.
//
// Dipakai dari DM/grup (BUKAN dari dalam saluran): pipeline bot sengaja
// mengabaikan pesan newsletter (shouldIgnoreJid + filter jenis chat),
// jadi perintah tidak pernah direspon di dalam saluran dan m.chat tidak
// bisa diintip dari sana. Jalur yang didukung Baileys adalah sebaliknya:
//   .channelinfo <link saluran>   (disalin dari aplikasi WA: Bagikan ->
//                                  Salin link, mis. whatsapp.com/channel/...)
//   .channelinfo <kode undangan>
//   .channelinfo <JID saluran>    (120363xxx@newsletter)
//   .channelinfo (reply pesan yang berisi link/kode/JID)
// Balasan: nama, deskripsi, ID (JID — nilai yang dibutuhkan
// `.config set botChannel`), link, jumlah pengikut, verifikasi, peran
// akun bot (admin/pemilik/tamu/pengikut — .bcc butuh admin/pemilik),
// waktu dibuat, dan ada/tidaknya foto.
//
// Bukan .channellist: Baileys tidak punya endpoint daftar semua saluran
// (grup punya groupFetchAllParticipating, saluran tidak), jadi tidak ada
// yang bisa dienumerasi — satu saluran per panggilan, lewat metadata.
// Founder-only, karena ini perkakas penyiapan saluran siaran founder.

import { reactTo, REACT } from '#lib/helpers/react.js'
import { parseChannelInput, normalizeChannelMetadata, formatChannelInfo } from '#lib/helpers/channelInfo.js'

let handler = async (m, ctx) => {
  const conn = ctx?.conn ?? m.conn
  if (typeof conn?.newsletterMetadata !== 'function') throw 'Koneksi bot tidak menyediakan API saluran (newsletterMetadata tidak ada).'
  const input = String(ctx.text ?? '').trim() || String(m.quoted?.text ?? m.quoted?.caption ?? '').trim()
  const { type, key } = parseChannelInput(input)
  await reactTo(m, REACT.processing, { conn }).catch(() => {})
  let raw
  try {
    raw = await conn.newsletterMetadata(type, key)
  } catch (e) {
    throw `Gagal membaca metadata saluran: ${String(e?.message ?? e).slice(0, 200)}`
  }
  const info = normalizeChannelMetadata(raw)
  if (!info) throw 'Saluran tidak ditemukan — periksa lagi link/kode/JID-nya.'
  await reactTo(m, REACT.done, { conn }).catch(() => {})
  await m.reply(formatChannelInfo(info))
}

handler.help = ['channelinfo <link/kode/JID saluran>']
handler.tags = ['owner']
handler.command = ['channelinfo']
handler.founder = true

export default handler
