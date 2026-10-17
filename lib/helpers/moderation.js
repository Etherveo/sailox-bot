export async function moderate(m, { conn, command, text, participants }) {
  if (command.endsWith('chat')) {
    if (!m.isGroup) throw 'Gunakan perintah ini di grup.'
    global.db.ensure('chats', m.chat).isBanned = command === 'banchat'; await global.db.save('chats')
  } else {
    const target = await conn.identity.resolve(text, { m, participants })
    if (!target?.lid || target.source === 'typed-unverified') throw 'Identitas target belum terverifikasi.'
    const u = global.db.ensure('users', target.lid, target)
    if (command === 'banuser' && conn.identity.roleOf(target.lid).isOwner) throw 'Owner tidak dapat diblokir.'
    u.banned = command === 'banuser'; u.banReason = ''; u.banExpires = 0; await global.db.save('users')
  }
  await m.reply('Pengaturan ban disimpan.')
}
