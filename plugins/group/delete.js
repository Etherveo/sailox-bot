// plugins/group/delete.js
//
// .delete / .del / .d — hapus pesan lewat reply (versi grup, ber-prefix;
// spek Veo 2026-11-25, dipertahankan 2026-11-26 00:31, dikoreksi
// 2026-11-26 ~00:54 di KDN - Automation).
//
// Aturan versi grup:
//   - Reply pesan ORANG LAIN -> HANYA di grup. Syarat: bot admin DAN
//     pengirim pesan itu admin grup. Bukan grup / bot bukan admin /
//     pengirim bukan admin -> ditolak dengan string yang jelas.
//   - Reply pesan BOT SENDIRI -> di DM bebas; DI GRUP BOLEH asalkan
//     pengirim perintahnya admin grup (koreksi Veo 2026-11-26 ~00:54:
//     "di grup boleh hapus pesan bot asalkan sender-nya admin" —
//     menggantikan aturan lama "hanya bisa di DM"). Bukan admin ->
//     ditolak dengan string yang jelas. Hapus pesan bot sendiri tidak
//     butuh bot admin; hapus pesan perintah .delete itu sendiri
//     DILEWATKAN bila bot bukan admin (koreksi Veo 2026-11-26 ~01:01:
//     "dilewatkan saja, diabaikan tanpa pesan pemberitahuan apa pun,
//     yang penting penghapusan pesan botnya jalan") — tidak dicoba
//     sama sekali, bukan dicoba-lalu-gagal-diam-diam.
//   - Tanpa reply -> pesan pemakaian.
//   - Di grup, pesan perintah .delete itu sendiri ikut dihapus (bila
//     bot admin) — konfirmasi cukup reaksi ✅ pada pesan perintah
//     sebelum dihapus; di DM tidak ada balasan sukses (keputusan Veo
//     2026-11-26 ~01:01: pesan sukses dihapus) — hilangnya pesan itu
//     sendiri konfirmasinya.
//   - TIDAK ada gerbang "pengirim harus admin" untuk hapus pesan ORANG
//     LAIN — sengaja: legacy punya handler.admin = true (user harus
//     admin), tapi Veo memutuskan 2026-11-26 00:31 versi biasa TETAP
//     seperti spek semula, jadi gerbang itu TIDAK di-port untuk cabang
//     itu. Jangan tambah tanpa kata Veo. (Gerbang pengirim-admin hanya
//     berlaku untuk hapus pesan BOT SENDIRI di grup, per koreksi di
//     atas.)
//
// Ini BUKAN port mentah legacy: legacy tidak punya aturan target-admin,
// tidak punya batasan DM-untuk-pesan-bot, dan tidak konfirmasi apa pun
// (hapus diam-diam) — ketiganya sengaja dipertahankan di versi grup.
// Yang diambil dari legacy hanyalah nama + konsep varian owner-nya
// (odelete) dan mekanisme delete-nya (conn.sendMessage(chat,
// { delete: key }), preseden _antilink.js). Alias legacy
// "unsend"/"unsen" tidak dipakai: trigger menurut Veo 2026-11-26 00:33
// adalah d(?:el(?:ete)?)? — persis "d"/"del"/"delete".
//
// Bebas limit (semua fitur grup bebas limit — keputusan Veo
// 2026-11-25): plugin ini TIDAK memasang handler.limit.
import { findParticipant, isAdminParticipant } from '#lib/helpers/groupTargets.js'
import { reactTo, REACT } from '#lib/helpers/react.js'

const usage = usedPrefix =>
  `Reply pesan yang mau dihapus, lalu ketik ${usedPrefix}delete (alias: ${usedPrefix}del / ${usedPrefix}d).\n` +
  `Di grup: pesan bot sendiri boleh dihapus asal pengirim perintah admin; pesan orang lain hanya pesan admin (dan bot harus admin).\n` +
  `Di DM: hanya pesan bot sendiri.`

async function deleteKey(conn, chat, key) {
  await conn.sendMessage(chat, { delete: key })
}

let handler = async (m, ctx) => {
  const { conn, usedPrefix, isBotAdmin, participants } = ctx
  const q = m.quoted
  if (!q?.key) throw usage(usedPrefix)
  if (q.fromMe) {
    // Pesan bot sendiri: di DM bebas; di grup hanya bila pengirim
    // perintahnya admin (koreksi Veo 2026-11-26 ~00:54, KDN).
    if (!m.isGroup) {
      await deleteKey(conn, m.chat, q.key)
      return
    }
    const sender = findParticipant(participants, m.sender)
    if (!isAdminParticipant(sender)) throw 'Di grup, hanya admin yang boleh menghapus pesan bot.'
    await reactTo(m, REACT.done).catch(() => {})
    await deleteKey(conn, m.chat, q.key)
    // Hapus juga pesan perintah .delete itu sendiri — HANYA bila bot
    // admin (koreksi Veo 2026-11-26 ~01:01): bila bot bukan admin,
    // penghapusan pesan perintah DILEWATKAN saja (tidak dicoba,
    // tanpa pesan pemberitahuan apa pun); yang penting penghapusan
    // pesan botnya jalan.
    if (isBotAdmin) await deleteKey(conn, m.chat, m.key).catch(() => {})
    return
  }
  // Pesan orang lain: hanya di grup, bot admin, pengirim pesan admin.
  if (!m.isGroup) throw 'Menghapus pesan orang lain hanya bisa di grup — di DM WhatsApp tidak mengizinkan bot menghapus pesan lawan bicara.'
  if (!isBotAdmin) throw 'Bot harus jadi admin grup dulu supaya bisa menghapus pesan orang lain.'
  const target = findParticipant(participants, q.sender)
  if (!isAdminParticipant(target)) throw 'Bot hanya menghapus pesan dari admin grup.'
  await reactTo(m, REACT.done).catch(() => {})
  await deleteKey(conn, m.chat, q.key)
  // Hapus juga pesan perintah .delete itu sendiri (bot admin di sini).
  await deleteKey(conn, m.chat, m.key).catch(() => {})
}

handler.help = ['delete (reply pesan)', 'del (reply pesan)', 'd (reply pesan)']
handler.tags = ['group']
handler.command = /^(d(?:el(?:ete)?)?)$/i
export default handler
