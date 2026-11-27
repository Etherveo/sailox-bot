// Moderasi pengguna (.banuser/.unbanuser): mengabaikan SATU pengguna
// spesifik — pipeline (lib/plugins/pipeline.js) mengembalikan pesannya
// di mana pun (DM maupun grup) bila record users-nya user.isBanned.
// Beda dengan .banchat (plugins/owner/banchat.js) yang memblokir CHAT:
// chat.isBanned true → bot mengabaikan chat itu, tidak ada yang bisa
// command di sana (kecuali owner — supaya owner tetap bisa .allowchat
// dari dalam).
//
// Target (dipakai conn.identity.resolve — urutan: reply > tag >
// ketikan, seperti .kick):
//   .banuser 628xxx / 08xxx (angka 0 depan diubah ke 62), tag, reply,
//   atau JID/LID yang diketik utuh.
//   Tanpa argumen dan BUKAN grup/channel: targetnya lawan bicara DM
//   (m.chat). Di DM owner dengan bot sendiri, lawan bicaranya owner —
//   itu bukan target yang bisa di-ban, jadi yang keluar pesan pemakaian
//   (bukan 'Owner tidak dapat diblokir').
//
// LID vs JID — kenapa nomor yang diketik bisa di-ban meski LID-nya
// belum diketahui: record users keyed by LID, dan LID seseorang hanya
// diketahui bot setelah ada interaksi. Bila target hanya dikenal
// lewat nomor (typed-unverified), ban disimpan di record keyed by JID
// (banned: true). Begitu pemetaan JID↔LID dipelajari — identity.learn,
// saat orang itu pertama kali berinteraksi (participantAlt di DM,
// peserta grup) — record JID digabung ke record LID dan ban ikut
// terbawa (merged.banned = old || current, lihat
// lib/identity/resolver.js learn). Jadi ban nomor tak dikenal AKTIF
// sejak pesan pertamanya, tanpa perlu perintah ulang. Unban nomor tak
// dikenal yang memang belum pernah di-ban: tidak ada record yang
// dibuat (dilaporkan 'tidak sedang diblokir').
import { normalize, kind } from '#lib/identity/resolver.js'

const digitsOf = id => String(id ?? '').split('@')[0].split(':')[0].replace(/\D/g, '')

export async function moderate(m, { conn, command, text, participants, usedPrefix }) {
  const banning = command === 'banuser'
  const prefix = usedPrefix ?? '.'
  const usage = `Siapa yang mau ${banning ? 'diblokir' : 'dibuka blokirnya'}?\nContoh: ${prefix}${command} 628xxx — atau reply/tag. (Di DM, tanpa argumen = lawan bicara.)`
  const argText = String(text ?? '').trim()

  // Id grup yang diketik ke .banuser: itu ranah .banchat.
  if (argText && kind(normalize(argText)) === 'group') throw 'Itu id grup — pakai .banchat untuk memblokir chat grup.'

  let target = await conn.identity.resolve(argText, { m, participants })
  let fromCounterpart = false
  // Tanpa target: di DM, targetnya lawan bicara; di grup, harus disebut.
  if (!target && !m.isGroup && m.chat && ['pn', 'lid'].includes(kind(normalize(m.chat)))) {
    target = await conn.identity.resolve(m.chat, { m, participants })
    fromCounterpart = true
  }
  if (!target) throw usage
  const id = target.lid ?? target.jid
  // Lawan bicara DM yang ternyata owner/bot sendiri: bukan target —
  // pemilik perintah hampir pasti lupa argumen, jadi beri pemakaian.
  if (fromCounterpart && (conn.identity.isBot(id) || conn.identity.roleOf(id).isOwner)) throw usage
  if (conn.identity.isBot(id) || conn.identity.isBot(target.jid)) throw 'Itu botnya sendiri.'
  if (conn.identity.roleOf(target.lid ?? target.jid).isOwner) throw 'Owner tidak dapat diblokir.'
  const label = digitsOf(target.jid ?? target.lid)

  // Jalur biasa: LID diketahui — record users keyed by LID.
  if (target.lid) {
    const u = global.db.ensure('users', target.lid, target)
    u.banned = banning; u.banReason = ''; u.banExpires = 0
    await global.db.save('users')
    await m.reply(banning ? `Pengguna ${label} diblokir.` : `Blokir pengguna ${label} dicabut.`)
    return
  }
  // LID belum diketahui: simpan ban di record keyed by JID (lihat
  // header file — digabung ke LID begitu pemetaannya dipelajari).
  const existing = global.db.data.users[target.jid]
  if (!banning && !existing?.banned) {
    await m.reply(`Nomor ${label} tidak sedang diblokir.`)
    return
  }
  const u = global.db.ensure('users', target.jid, { lid: '', jid: target.jid })
  u.banned = banning; u.banReason = ''; u.banExpires = 0
  await global.db.save('users')
  await m.reply(banning
    ? `Pengguna ${label} diblokir. (Pemetaan LID belum diketahui — ban aktif begitu dia pertama kali berinteraksi dengan bot.)`
    : `Blokir pengguna ${label} dicabut.`)
}
