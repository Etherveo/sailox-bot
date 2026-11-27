// Store daftar .unprefix: SATU plugin, DUA store yang tidak tercampur.
//
//   Bot utama (conn.role 'main'/tidak ada): daftar per grup di record
//     chats (chat.unprefix) — perilaku lama, tidak berubah sedikit pun.
//   Sub-bot (conn.role === 'sub', worker lib/subbot/runtime/worker.js):
//     daftar per grup di koleksi 'unprefix' — databases/unprefix.json DI
//     DALAM sandbox sub-bot itu sendiri, satu record per chat { words: [] }.
//
// Konteks dibedakan dari conn.role — penanda yang sudah ada (sock.role
// dipasang lib/simple.js decorateSocket: 'main' di bot utama, 'sub' di
// worker; dipakai juga pipeline saat menghitung peran pengirim). Tidak
// perlu penanda baru di worker.js.
//
// Fallback aman: bila conn/role hilang (mis. handler dipanggil tanpa
// conn), kembalikan perilaku bot utama — TIDAK PERNAH membaca store
// sub-bot tanpa penanda yang jelas. Di konteks sub-bot pun, bila penanda
// hilang, yang terbaca hanya chats.json sandbox itu sendiri (DB sub-bot
// sudah terpisah dari DB utama), jadi tidak ada kebocoran data utama.
//
// Dipakai dua tempat: plugins/group/unprefix.js (tambah/list/del) dan
// fallback .unprefix di lib/plugins/pipeline.js.
export function isSubBotContext(conn) {
  return conn?.role === 'sub'
}

// Baca daftar kata (salinan) untuk satu chat — tanpa membuat record baru.
export function getUnprefixWords(db, chatId, conn) {
  if (isSubBotContext(conn)) {
    const rec = db?.data?.unprefix?.[chatId]
    return Array.isArray(rec?.words) ? [...rec.words] : []
  }
  const rec = db?.data?.chats?.[chatId]
  return Array.isArray(rec?.unprefix) ? [...rec.unprefix] : []
}

// Tulis daftar kata untuk satu chat (buat record bila belum ada) dan
// simpan koleksinya — 'unprefix' di sub-bot, 'chats' di bot utama.
export async function setUnprefixWords(db, chatId, conn, words) {
  const list = [...new Set((words ?? []).map(w => String(w).trim().toLowerCase()).filter(Boolean))]
  if (isSubBotContext(conn)) {
    db.ensure('unprefix', chatId).words = list
    await db.save('unprefix')
  } else {
    db.ensure('chats', chatId).unprefix = list
    await db.save('chats')
  }
}
