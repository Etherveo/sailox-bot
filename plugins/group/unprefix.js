// .unprefix — bikin perintah tertentu bisa dipakai tanpa prefix di grup ini.
//
//   .unprefix <perintah>     tambah kata ke daftar grup ini
//   .unprefix list           lihat daftar perintah tanpa prefix
//   .unprefix del <perintah> hapus dari daftar
//
// Daftar disimpan per grup — store-nya bercabang menurut konteks
// (lib/helpers/unprefixStore.js): bot utama di record chats
// (chat.unprefix), sub-bot di koleksi 'unprefix' (databases/unprefix.json
// di dalam sandbox sub-bot itu sendiri). Satu plugin, dua store yang
// tidak pernah tercampur; entri lama bot utama tidak berubah.
// Yang boleh mengubah: owner (TANPA harus admin grup — perintah Veo
// 2026-11-26 22:07) atau admin grup; semuanya harus premium
// (handler.premium; founder/owner/mods lolos premium otomatis).
// Gerbang admin dicek DI DALAM handler (bukan handler.admin) supaya
// owner lolos — handler.admin pipeline tidak punya pengecualian owner.
// Fitur grup = bebas limit (keputusan Veo 2026-11-25).
//
// Pencocokan di pipeline (lib/plugins/pipeline.js +
// findUnprefixEntry/unprefixFallbackForPlugin di lib/helpers/parsing.js):
// satu kata di daftar = SELURUH plugin-nya, termasuk semua alias —
// '.unprefix ping' membebaskan bare 'ping' DAN bare 'p' (keduanya
// trigger plugin ping); kata yang diketik hanya label untuk mengenali
// plugin, bukan satu-satunya kata yang dibebaskan. Entri lama di daftar
// ikut perilaku baru tanpa migrasi karena resolusi kata→plugin jalan
// saat runtime. Kata pertama pesan harus cocok dengan command plugin
// (regex berjangkar ^...$) — 'sa,' memicu, 'saya'/'satu'/'menuku' tidak.
// Unprefix HANYA mengubah trigger, BUKAN izin: limit, registrasi, dan
// gerbang owner/premium/nsfw plugin tujuan tetap berlaku, dan plugin
// yang dimatikan tetap ditolak.
//
// Disambiguasi: 'del' hanya dianggap subcommand bila diikuti kata
// (.unprefix del sa = hapus 'sa'); '.unprefix del' tanpa kata kedua
// berarti TAMBAH kata 'del' (alias .delete). 'list' selalu menampilkan
// daftar — tidak ada perintah bernama 'list', jadi tidak ambigu.
import { findUnprefixEntry } from '#lib/helpers/parsing.js'
import { getUnprefixWords, setUnprefixWords } from '#lib/helpers/unprefixStore.js'

export const UNPREFIX_MAX = 20

const USAGE = `Cara pakai .unprefix (admin grup + premium):
.unprefix <perintah> — perintah bisa dipakai tanpa prefix di grup ini
.unprefix list — lihat daftar perintah tanpa prefix
.unprefix del <perintah> — hapus dari daftar`

// Daftar unprefix grup (record lama yang belum punya field-nya — mis.
// dibuat sebelum bump versi chats — diperlakukan sebagai daftar kosong).
export function unprefixList(chat) {
  return Array.isArray(chat?.unprefix) ? [...chat.unprefix] : []
}

// Cari plugin yang perintahnya cocok dengan kata ini (validasi
// .unprefix <kata>) — wrapper tipis di atas findUnprefixEntry supaya
// import lama tidak rusak. Satu kata = satu plugin: alias lain dari
// plugin yang sama mengenali plugin yang sama pula.
export function findUnprefixCommand(word, entries) {
  return findUnprefixEntry(word, entries)?.plugin ?? null
}

let handler = async (m, { args, isOwner, isAdmin, conn }) => {
  // Gerbang admin di sini (bukan handler.admin): owner lolos tanpa harus
  // admin grup; admin biasa tetap harus admin. Pesan sama persis seperti
  // gerbang pipeline 'admin' (lib/helpers/messages.js) supaya balasan ke
  // non-owner tidak berubah.
  if (!isOwner && !isAdmin) throw 'Perintah ini khusus admin grup.'
  const [sub, rawWord] = args ?? []
  const db = globalThis.db
  const list = getUnprefixWords(db, m.chat, conn)
  if (!sub) throw USAGE
  const subLower = String(sub).toLowerCase()
  if (subLower === 'list') {
    if (!list.length) {
      await m.reply('Belum ada perintah tanpa prefix di grup ini.\nTambah dengan: .unprefix <perintah>')
      return
    }
    await m.reply('Perintah tanpa prefix di grup ini:\n' + list.map(w => '• ' + w).join('\n') + '\n\nSatu label = seluruh perintah plugin itu, termasuk aliasnya.\nHapus dengan: .unprefix del <perintah>')
    return
  }
  const entries = globalThis.pluginLoader?.list?.() ?? []
  if (subLower === 'del' && rawWord) {
    const word = String(rawWord).trim().toLowerCase()
    // Hapus berdasarkan plugin juga: tambah via 'ping', hapus via 'p'.
    // Bila kata bukan perintah nyata, hanya label yang sama persis yang
    // bisa terhapus (label di daftar selalu perintah nyata).
    const target = findUnprefixEntry(word, entries)
    const removed = list.filter(l => l === word || (target && findUnprefixEntry(l, entries)?.id === target.id))
    if (!removed.length) throw `*${word}* tidak ada di daftar tanpa prefix grup ini.`
    await setUnprefixWords(db, m.chat, conn, list.filter(l => !removed.includes(l)))
    await m.reply(`✅ *${removed.join(', ')}* dihapus dari daftar tanpa prefix.`)
    return
  }
  // Tambah: kata yang ditambahkan adalah sub itu sendiri — termasuk
  // '.unprefix del' (tanpa kata kedua) yang berarti tambah kata 'del'.
  const word = subLower
  const entry = findUnprefixEntry(word, entries)
  if (!entry) throw `Tidak ada perintah *${word}* yang bisa dipakai tanpa prefix di grup ini.`
  // Duplikat berdasarkan PLUGIN, bukan kata: alias lain dari plugin yang
  // sama sudah diwakili label lama — sebutkan labelnya.
  const existing = list.find(l => findUnprefixEntry(l, entries)?.id === entry.id)
  if (existing) throw `*${word}* sudah ada di daftar tanpa prefix grup ini sebagai *${existing}* — satu label mencakup seluruh perintah plugin itu, termasuk aliasnya.`
  if (list.length >= UNPREFIX_MAX) throw `Daftar tanpa prefix grup ini sudah penuh (maks ${UNPREFIX_MAX} perintah).\nHapus dulu dengan: .unprefix del <perintah>`
  list.push(word)
  await setUnprefixWords(db, m.chat, conn, list)
  await m.reply(`✅ *${word}* sekarang bisa dipakai tanpa prefix di grup ini.\nSemua nama perintah plugin itu (termasuk aliasnya) ikut bisa dipakai tanpa prefix.\nKetik *${word}* (tanpa .) untuk memakainya — kata harus berdiri sendiri, bukan menempel pada kata lain.`)
}
handler.help = ['unprefix <perintah>', 'unprefix list', 'unprefix del <perintah>']
handler.tags = ['group']
handler.command = /^unprefix$/i
handler.group = true
handler.premium = true
// Dibagikan ke sub-bot (handler.sharing): plugin ikut tercopy ke sandbox
// saat scaffold + hash-nya dipercaya policy worker. Store daftarnya
// tetap terpisah lewat lib/helpers/unprefixStore.js — sub-bot memakai
// databases/unprefix.json di sandbox-nya sendiri, bukan chats bot utama.
// TANPA handler.admin — gerbang admin ada di dalam handler (lihat atas)
// supaya owner tidak perlu jadi admin grup (perintah Veo 2026-11-26).
// TANPA handler.limit — fitur grup bebas limit (keputusan Veo 2026-11-25;
// lihat tests/pluginLimits.test.js).
handler.sharing = true
export default handler
