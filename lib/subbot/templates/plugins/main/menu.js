let handler = async (m, { args, usedPrefix }) => {
  const grouped = new Map()
  for (const { plugin } of global.pluginLoader.list()) {
    if (plugin.disabled || !plugin.help.length) continue
    for (const tag of plugin.tags.length ? plugin.tags : ['misc']) { if (args[0] && tag !== args[0].toLowerCase()) continue; grouped.set(tag, [...(grouped.get(tag) ?? []), ...plugin.help.map(h => `${usedPrefix}${h}`)]) }
  }
  await m.reply(`*${global.namebot || 'Sailox'}*\n` + [...grouped].map(([tag, help]) => `\n*${tag}*\n${help.join('\n')}`).join('\n'))
}
handler.help = ['menu [kategori]']; handler.tags = ['main']; handler.command = /^(menu|help)$/i
export default handler
