// Moderasi pengguna (.banuser/.unbanuser): target harus terpetakan ke
// LID (record users keyed by LID) — lihat lib/identity/resolver.js.
// Moderasi chat (.banchat/.unbanchat) tinggal di
// plugins/owner/banchat.js (satu plugin untuk kedua perintah, supaya
// alurnya terbaca utuh di sana, AGENTS.md §12).
export async function moderate(m, { conn, command, text, participants }) {
  const target = await conn.identity.resolve(text, { m, participants })
  if (!target?.lid || target.source === 'typed-unverified') throw 'Identitas target belum terverifikasi.'
  const u = global.db.ensure('users', target.lid, target)
  if (command === 'banuser' && conn.identity.roleOf(target.lid).isOwner) throw 'Owner tidak dapat diblokir.'
  u.banned = command === 'banuser'; u.banReason = ''; u.banExpires = 0; await global.db.save('users')
  await m.reply('Pengaturan ban disimpan.')
}
