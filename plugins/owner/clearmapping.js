// .clearmapping / .cmp — kosongkan SEMUA mapping nama file anime.
// Porting legacy owner-clearmapping.js dengan satu pengaman Sailox:
// legacy menghapus seketika; di sini wajib konfirmasi eksplisit
// (argumen "ya") karena isinya modal data hasil .amp manual + impor.
import { activeAnimeNameMap } from '#lib/helpers/animeNameMap.js'

let handler = async (m, { text, usedPrefix, command }) => {
  const store = activeAnimeNameMap()
  const total = Object.keys(store.list()).length
  if (!total) return m.reply('📭 Mapping sudah kosong.')

  if (String(text ?? '').trim().toLowerCase() !== 'ya') {
    return m.reply(
      `⚠️ Perintah ini menghapus SEMUA mapping anime (${total} entri).\n` +
      `Kalau yakin, ulangi dengan: ${usedPrefix + command} ya`
    )
  }

  store.clear()
  m.reply(
    `🧹 *Anime Batch Mapping berhasil dibersihkan*\n\n` +
    `• Total mapping dihapus: *${total}*`
  )
}

handler.help = ['clearmapping/cmp']
handler.tags = ['owner']
handler.command = /^c(lear)?m(ap)?p(ing)?$/i
handler.founder = true

export default handler
