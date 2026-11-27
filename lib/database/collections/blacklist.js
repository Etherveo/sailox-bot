// Koleksi 'blacklist': daftar hitam GLOBAL (bukan per-chat) untuk
// plugins/owner/blacklist.js — satu record per orang { jid, lid,
// addedBy, addedAt }, kunci = bentuk kanonis yang pertama diketahui
// (LID bila ada, kalau tidak JID nomor telepon).
//
// Store ini GLOBAL, jadi satu koleksi saja sudah otomatis terpisah:
// bot utama membaca databases/blacklist.json miliknya, sub-bot membaca
// databases/blacklist.json DI DALAM sandbox-nya sendiri — tidak perlu
// branching isSubBotContext seperti .unprefix (yang per-chat).
// Worker memuat koleksi ini otomatis: lib/subbot/runtime/worker.js
// membangun Database dengan descriptors bawaan (semua koleksi di
// lib/database/collections/index.js, kecuali 'subbots' di konteks sub).
export default { name: 'blacklist', version: 1, defaults: () => ({ jid: '', lid: '', addedBy: '', addedAt: 0 }) }
