import { buildMenuText } from '#lib/helpers/menuText.js'
// Menu ala _yue-menulox.js legacy (navigasi bernomor + halaman per kategori
// dengan sapaan & read-more), tapi isinya dinamis dari registry plugin
// engine sekarang. Logika render ada di lib/helpers/menuText.js.
let handler = async (m, { args, usedPrefix }) => {
  const text = buildMenuText({
    plugins: global.pluginLoader.list().map(entry => entry.plugin),
    input: args[0] ?? '',
    prefix: usedPrefix,
    namebot: global.namebot || 'Sailox',
    userName: m.name || '',
    timezone: global.timezone ?? 'Asia/Jakarta',
    uptimeSec: Math.floor(process.uptime()),
  })
  await m.reply(text)
}
handler.help = ['menu [kategori|nomor]']; handler.tags = ['main']; handler.command = /^(menu|help)$/i
export default handler
