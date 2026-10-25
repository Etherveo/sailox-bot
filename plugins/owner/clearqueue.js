import path from 'node:path'
import { getDownloadQueue } from '#lib/downloader/index.js'

// .clearqueue / .cq — founder-only: kosongkan antrean unduhan (.dl/.tt)
// supaya bisa ngetes ulang tanpa menunggu cooldown 1 menit maupun antrean
// yang masih menunggu. Menghapus: job pending, klaim manual .tt, dan
// seluruh daftar cooldown. Job yang sedang aktif dibiarkan (unduhannya
// sudah berjalan) dan dilaporkan jumlahnya.
let handler = async (m, ctx) => {
  const pluginsRoot = global.pluginLoader?.root
  const rootDir = pluginsRoot ? path.resolve(pluginsRoot, '..') : process.cwd()
  const queue = ctx.downloadQueue ?? getDownloadQueue(rootDir)
  const r = await queue.clearQueue()
  const lines = ['🧹 *Antrean dibersihkan*']
  if (!r.cleared && !r.recent && !r.active) {
    lines.push('Antrean sudah kosong — tidak ada yang dibersihkan.')
  } else {
    if (r.pending) lines.push(`• ${r.pending} job menunggu dihapus`)
    if (r.manual) lines.push(`• ${r.manual} klaim manual (.tt) dihapus`)
    if (r.recent) lines.push(`• ${r.recent} cooldown dihapus (bisa tes link yang sama lagi)`)
    if (r.active) lines.push(`• ${r.active} job aktif dibiarkan (sedang diunduh)`)
  }
  await m.reply(lines.join('\n'))
}
handler.help = ['clearqueue']
handler.tags = ['owner']
handler.command = /^(clearqueue|cq)$/i
handler.founder = true
export default handler
