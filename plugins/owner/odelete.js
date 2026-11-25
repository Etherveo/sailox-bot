// plugins/owner/odelete.js
//
// odelete — varian owner dari .delete (nama legacy: owner-odelete.js,
// help legacy ['odelete']). "odelete" HANYA nama varian (o = owner +
// delete), BUKAN kata trigger: trigger-nya tetap d(?:el(?:ete)?)? —
// persis "d"/"del"/"delete" — seperti versi grup, bedanya versi ini
// TANPA PREFIX (sebagai reply) + owner-only + batasan admin DILEPAS
// (keputusan Veo 2026-11-26 00:31, diluruskan 00:33).
//
//   - owner reply pesan lalu ketik persis d/del/delete (tanpa prefix,
//     tanpa teks lain) -> pesan itu terhapus.
//   - target siapa pun (tidak ada aturan target-harus-admin); pesan
//     bot sendiri boleh dihapus di grup juga (tidak DM saja).
//   - satu-satunya batasan yang tetap: bot harus admin untuk hapus
//     pesan orang lain di grup (syarat WA sendiri).
//   - tanpa reply / bukan owner / teks tidak persis -> diam (return
//     false), pesan mengalir normal tanpa penolakan.
//
// Berjalan sebagai handler.before (pola pick.js), BUKAN plugin prefixless
// dispatchable seperti legacy (customPrefix): bentuk dispatchable akan
// membuat bot membalas "Perintah ini khusus founder." ke siapa pun yang
// mengetik kata "d" telanjang di grup — noise. Bentuk before diam untuk
// semua non-trigger. Mekanisme ini diizinkan eksplisit oleh tugas
// (handler.before "atau mekanisme prefixless yang kamu pakai").
//
// Perbedaan dari legacy (sengaja, kata Veo menang):
//   - trigger legacy d|del|delete|unsend; di sini d/del/delete saja
//     (regex Veo d(?:el(?:ete)?)?) — "odelete" BUKAN trigger.
//   - legacy tanpa reply -> hapus pesan "del"-nya sendiri; di sini
//     tanpa reply -> diam (trigger mensyaratkan reply).
//   - legacy gerbang rowner (founder-only); di sini ctx.isOwner
//     (owner Sailox) — sesuai kata Veo "owner only". Bila mau
//     founder-only, ganti isOwner -> isFounder.
//   - legacy gagal hapus diam-diam (send tidak di-await); di sini
//     gagal -> dibalas string yang jelas (aturan error Veo 2026-11-25).
//
// Tanpa handler.limit (plugin owner tidak boleh pasang limit — tes
// invarian pluginLimits; before-hook pun tidak memotong limit).
// Tidak muncul di menu (help kosong, seperti pick.js dan eval/exec):
// perintah owner tanpa prefix tidak bisa dipanggil lewat ".odelete".

const ODEDELETE_WORDS = /^(d(?:el(?:ete)?)?)$/i

let handler = async () => {}
handler.help = []
handler.tags = ['owner']
handler.before = async (m, ctx) => {
  const { conn, isOwner, isBotAdmin } = ctx ?? {}
  if (!isOwner) return false
  const q = m.quoted
  if (!q?.key) return false
  if (!ODEDELETE_WORDS.test((m.text ?? '').trim())) return false
  try {
    if (q.fromMe) {
      await conn.sendMessage(m.chat, { delete: q.key })
      return true
    }
    if (!m.isGroup) {
      await m.reply('Bot tidak bisa menghapus pesan orang lain di DM — hanya di grup (dan bot harus admin).')
      return true
    }
    if (!isBotAdmin) {
      await m.reply('Bot harus jadi admin grup dulu supaya bisa menghapus pesan orang lain.')
      return true
    }
    await conn.sendMessage(m.chat, { delete: q.key })
    return true
  } catch (e) {
    await m.reply('Gagal menghapus pesan itu — mungkin pesannya sudah terlalu lama atau sudah terhapus.').catch(() => {})
    return true
  }
}
export default handler
