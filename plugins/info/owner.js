// .owner — kirim kartu kontak (contact message) owner bot.
//
// Spek founder 2026-11-25 (grup KDN - Automation): ".owner" membuat bot
// otomatis mengirim kontak owner — HANYA index pertama, bukan semuanya.
// Satu file utuh tanpa helper: ambil entri pertama dari global.founder
// (jatuh ke global.owner bila founder kosong), lalu kirim sebagai contact
// message lewat conn.sendContact (vCard, bukan teks nomor).
//
// Entri owner berbentuk [nomor, lid, nama] (lihat config.js); nomor
// diubah ke JID PN lengkap sebelum dikirim, karena sendContact
// menyelesaikannya lewat conn.identity.toJid yang butuh bentuk JID.
// Nama diambil dari entri config (bukan pushName/DB) — itulah nama yang
// founder daftarkan untuk owner.
//
// Ikut aturan limit seperti plugin info lain (handler.limit = true):
// sekali .owner = 1 limit (premium/mods bebas).
let handler = async (m, { conn }) => {
  const entry = globalThis.founder?.[0] ?? globalThis.owner?.[0]
  const number = String(Array.isArray(entry) ? entry[0] : entry ?? '').replace(/\D/g, '')
  if (!/^62\d{7,13}$/.test(number)) throw 'Owner belum diatur — isi dulu daftar founder/owner di config.'
  const name = String((Array.isArray(entry) ? entry[2] : '') ?? '').trim() || 'Owner'
  await conn.sendContact(m.chat, [[`${number}@s.whatsapp.net`, name]], m)
}
handler.help = ['owner']; handler.tags = ['info']; handler.command = /^owner$/i
handler.limit = true
export default handler
