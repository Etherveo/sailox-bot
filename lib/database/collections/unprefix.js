// Koleksi 'unprefix': daftar kata tanpa prefix PER GRUP untuk SUB-BOT.
//
// Bot utama TIDAK memakai koleksi ini — daftarnya tetap di record chats
// (chat.unprefix, koleksi 'chats'), supaya perilaku dan data lama tidak
// berubah. Sub-bot (worker, conn.role === 'sub') menyimpan daftarnya di
// sini: databases/unprefix.json DI DALAM sandbox-nya sendiri, satu record
// per chat { words: [] }. File-nya terpisah dari chats.json bot utama
// maupun chats.json sandbox, jadi daftar sub-bot tidak pernah tercampur
// dengan daftar bot utama. Baca/tulis lewat lib/helpers/unprefixStore.js.
export default { name: 'unprefix', version: 1, defaults: () => ({ words: [] }) }
