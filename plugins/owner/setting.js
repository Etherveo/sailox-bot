// Konfigurasi opt-in yang diperlukan untuk mencoba welcome/detect/antiDelete/jadibot.
let handler = async (m, { args, isAdmin, isOwner, chat, settings }) => {
  const [key, value] = args, enabled = value === 'on'
  if (!['on', 'off'].includes(value)) throw 'Gunakan .setting <fitur> on|off'
  if (['welcome', 'detect', 'delete', 'antiLink', 'game', 'rpg', 'nsfw'].includes(key)) { if (!m.isGroup || (!isAdmin && !isOwner)) throw 'Khusus admin grup/owner di grup.'; chat[key] = enabled; await global.db.save('chats') }
  else if (['jadibot', 'autoread', 'pconly', 'gconly'].includes(key)) { if (!isOwner) throw 'Khusus owner bot.'; settings[key] = enabled; await global.db.save('settings') }
  else throw 'Fitur tidak dikenal.'
  await m.reply(`${key}: ${value}`)
}
handler.help = ['setting <fitur> on|off']; handler.tags = ['owner']; handler.command = /^setting$/i
export default handler
