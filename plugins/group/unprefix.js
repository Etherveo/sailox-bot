// .unprefix — bikin perintah tertentu bisa dipakai tanpa prefix di grup ini.
//
//   .unprefix <perintah>     tambah kata ke daftar grup ini
//   .unprefix list           lihat daftar perintah tanpa prefix
//   .unprefix del <perintah> hapus dari daftar
//
// Daftar disimpan per grup di record chats (chat.unprefix, array kata
// huruf kecil) — pola yang sama seperti mode swgc (plugins/group/group.js).
// Yang boleh mengubah: admin grup + premium (handler.admin +
// handler.premium; founder/owner/mods lolos premium otomatis).
// Fitur grup = bebas limit (keputusan Veo 2026-11-25).
//
// Pencocokan di pipeline (lib/plugins/pipeline.js + unprefixFallbackInput
// di lib/helpers/parsing.js): bila pesan tidak ber-prefix dan kata
// pertamanya cocok WHOLE-WORD (case-insensitive) dengan daftar grup,
// pesan dijalankan seolah ber-prefix. Kata harus berdiri sendiri —
// 'sa,' memicu, 'saya'/'satu'/'menuku' tidak. Unprefix HANYA mengubah
// trigger, BUKAN izin: limit, registrasi, dan gerbang owner/premium/nsfw
// plugin tujuan tetap berlaku, dan plugin yang dimatikan tetap ditolak.
//
// Disambiguasi: 'del' hanya dianggap subcommand bila diikuti kata
// (.unprefix del sa = hapus 'sa'); '.unprefix del' tanpa kata kedua
// berarti TAMBAH kata 'del' (alias .delete). 'list' selalu menampilkan
// daftar — tidak ada perintah bernama 'list', jadi tidak ambigu.
import { commandMatches } from '#lib/helpers/parsing.js'

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
// .unprefix <kata>). Dilewati: plugin bukan fungsi, tanpa command, dan
// command regex kosong /(?:)/ — itu perintah prefixless murni
// (cekprefix, odelete) yang memang tidak punya nama perintah.
export function findUnprefixCommand(word, entries) {
  const w = String(word ?? '').trim().toLowerCase()
  if (!w) return null
  for (const { plugin } of entries ?? []) {
    if (typeof plugin !== 'function' || plugin.command == null) continue
    const commands = Array.isArray(plugin.command) ? plugin.command : [plugin.command]
    for (const c of commands) {
      if (c instanceof RegExp && c.source === '(?:)') continue
      if (typeof c === 'string' && !c) continue
      if (commandMatches(c, w)) return plugin
    }
  }
  return null
}

let handler = async (m, { args }) => {
  const [sub, rawWord] = args ?? []
  const rec = globalThis.db.ensure('chats', m.chat)
  const list = unprefixList(rec)
  if (!sub) throw USAGE
  const subLower = String(sub).toLowerCase()
  if (subLower === 'list') {
    if (!list.length) {
      await m.reply('Belum ada perintah tanpa prefix di grup ini.\nTambah dengan: .unprefix <perintah>')
      return
    }
    await m.reply('Perintah tanpa prefix di grup ini:\n' + list.map(w => '• ' + w).join('\n') + '\n\nHapus dengan: .unprefix del <perintah>')
    return
  }
  if (subLower === 'del' && rawWord) {
    const word = String(rawWord).trim().toLowerCase()
    const i = list.indexOf(word)
    if (i < 0) throw `*${word}* tidak ada di daftar tanpa prefix grup ini.`
    list.splice(i, 1)
    rec.unprefix = list
    await globalThis.db.save('chats')
    await m.reply(`✅ *${word}* dihapus dari daftar tanpa prefix.`)
    return
  }
  // Tambah: kata yang ditambahkan adalah sub itu sendiri — termasuk
  // '.unprefix del' (tanpa kata kedua) yang berarti tambah kata 'del'.
  const word = subLower
  if (list.includes(word)) throw `*${word}* sudah ada di daftar tanpa prefix grup ini.`
  if (list.length >= UNPREFIX_MAX) throw `Daftar tanpa prefix grup ini sudah penuh (maks ${UNPREFIX_MAX} perintah).\nHapus dulu dengan: .unprefix del <perintah>`
  const entries = globalThis.pluginLoader?.list?.() ?? []
  if (!findUnprefixCommand(word, entries)) throw `Tidak ada perintah *${word}* yang bisa dipakai tanpa prefix di grup ini.`
  list.push(word)
  rec.unprefix = list
  await globalThis.db.save('chats')
  await m.reply(`✅ *${word}* sekarang bisa dipakai tanpa prefix di grup ini.\nKetik *${word}* (tanpa .) untuk memakainya — kata harus berdiri sendiri, bukan menempel pada kata lain.`)
}
handler.help = ['unprefix <perintah>', 'unprefix list', 'unprefix del <perintah>']
handler.tags = ['group']
handler.command = /^unprefix$/i
handler.group = true
handler.admin = true
handler.premium = true
// TANPA handler.limit — fitur grup bebas limit (keputusan Veo 2026-11-25;
// lihat tests/pluginLimits.test.js).
export default handler
