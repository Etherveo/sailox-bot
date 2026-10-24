import path from 'node:path'
import { parseReplaceArgs, replaceInPlugins } from '#lib/helpers/pluginReplace.js'
// .replace <lama>|<baru> — ganti kata/frasa di semua plugin sekaligus
// (adaptasi owner-replace.js legacy, founder-only seperti legacy rowner).
// Bedanya: pemindaian rekursif mengikuti folder kategori engine sekarang,
// dan file yang hasil gantinya syntax-error dilewati, bukan ditulis rusak
// (gerbang yang sama seperti .saveplugin). File yang berubah dimuat ulang
// otomatis oleh watcher plugin.
let handler = async (m, { text, usedPrefix, command, __dirname }) => {
  const parsed = parseReplaceArgs(text)
  if (!parsed) throw `✍️ Format salah!\nContoh: ${usedPrefix + command} sailox|ilok`
  if (parsed.oldStr === parsed.newStr) throw 'Kata lama dan kata barunya sama persis — tidak ada yang perlu diganti.'
  await m.reply(`🔄 Mengubah *${parsed.oldStr}* menjadi *${parsed.newStr}* di semua plugin...`)
  const { edited, skipped, total } = await replaceInPlugins({ pluginsDir: path.resolve(__dirname, '..'), ...parsed })
  if (!edited.length && !skipped.length) return m.reply(`❌ Tidak ada plugin yang mengandung kata *"${parsed.oldStr}"*.`)
  const lines = []
  if (edited.length) lines.push(`✅ *${total}* kata diganti di *${edited.length}* plugin:`, '', ...edited.map(v => `• ${v.file} (${v.count}x)`))
  if (skipped.length) lines.push('', `⚠️ Dilewati karena hasil gantinya syntax error (${skipped.length} file):`, ...skipped.map(v => `• ${v.file} (${v.count}x)`))
  if (edited.length) lines.push('', 'Plugin yang berubah dimuat ulang otomatis.')
  await m.reply(lines.join('\n'))
}
handler.help = ['replace <lama>|<baru>']; handler.tags = ['owner']; handler.command = /^replace$/i
handler.founder = true
export default handler
