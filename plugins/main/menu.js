import { buildMenuText } from '#lib/helpers/menuText.js'
// Menu ala _yue-menulox.js legacy (navigasi bernomor + halaman per kategori
// dengan sapaan & read-more), tapi isinya dinamis dari registry plugin
// engine sekarang. Logika render ada di lib/helpers/menuText.js.
//
// Kategori owner bersifat khusus: pengguna selain owner/founder tidak bisa
// membukanya sama sekali (".menu owner"/aliasnya ditolak eksplisit, dan di
// navigasi maupun ".menu all" kategorinya disembunyikan — nomor urut pun
// dihitung dari daftar yang terlihat pemanggil).
let handler = async (m, { args, usedPrefix, isOwner }) => {
  const input = String(args[0] ?? '').trim().toLowerCase()
  // ctx pipeline selalu membawa isOwner boolean; ketiadaan field (pemanggil
  // di luar pipeline, mis. tes) diperlakukan sebagai owner agar perilaku
  // lama tidak berubah.
  const bukanOwner = isOwner === false
  if (bukanOwner && (input === 'owner' || input === 'own')) throw 'Menu Owner khusus owner/founder bot — kategori ini disembunyikan buat pengguna lain.'
  const text = buildMenuText({
    plugins: global.pluginLoader.list().map(entry => entry.plugin),
    input: args[0] ?? '',
    prefix: usedPrefix,
    namebot: global.namebot || 'Sailox',
    userName: m.name || '',
    timezone: global.timezone ?? 'Asia/Jakarta',
    uptimeSec: Math.floor(process.uptime()),
    hideOwner: bukanOwner,
  })
  await m.reply(text)
}
handler.help = ['menu [kategori|nomor|all]']; handler.tags = ['main']; handler.command = /^(menu|help)$/i
export default handler
