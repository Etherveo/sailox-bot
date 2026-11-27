let handler = async (m, { args, usedPrefix, isOwner }) => {
  // Kategori owner disembunyikan dari non-owner (seperti menu bot utama):
  // perintah owner tidak dicantumkan, dan '.menu owner' ditolak eksplisit.
  // isOwner yang tidak ada (pemanggil di luar pipeline, mis. tes langsung)
  // diperlakukan sebagai owner.
  const bukanOwner = isOwner === false
  if (bukanOwner && args[0]?.toLowerCase() === 'owner') throw 'Menu Owner khusus owner sub-bot — kategori ini disembunyikan buat pengguna lain.'
  const grouped = new Map()
  for (const { plugin } of global.pluginLoader.list()) {
    if (plugin.disabled || !plugin.help.length) continue
    if (bukanOwner && plugin.owner) continue
    for (const tag of plugin.tags.length ? plugin.tags : ['misc']) { if (args[0] && tag !== args[0].toLowerCase()) continue; grouped.set(tag, [...(grouped.get(tag) ?? []), ...plugin.help.map(h => `${usedPrefix}${h}`)]) }
  }
  await m.reply(`*${global.namebot || 'Sailox'}*\n` + [...grouped].map(([tag, help]) => `\n*${tag}*\n${help.join('\n')}`).join('\n'))
}
handler.help = ['menu [kategori]']; handler.tags = ['main']; handler.command = /^(menu|help)$/i
export default handler
