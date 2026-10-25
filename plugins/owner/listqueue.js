import path from 'node:path'
import { getDownloadQueue, providerLabel } from '#lib/downloader/index.js'

// .listqueue / .lq — founder-only: tampilkan seluruh antrean unduhan
// (.dl/.tt) plus daftar cooldown, untuk memantau dan mengetes. Berbeda
// dari `.dl antrean` (publik, hanya antrean peminta sendiri): ini melihat
// semua job dan semua cooldown. Nomor pengirim tidak ditampilkan, hanya
// nama tampilan bila ada.
let handler = async (m, ctx) => {
  const pluginsRoot = global.pluginLoader?.root
  const rootDir = pluginsRoot ? path.resolve(pluginsRoot, '..') : process.cwd()
  const queue = ctx.downloadQueue ?? getDownloadQueue(rootDir)
  const snap = await queue.snapshot()
  const lines = ['📥 *Daftar antrean*', `Sedang berjalan: ${snap.active} • Menunggu: ${snap.pending}`]
  const live = snap.jobs.filter(j => j.status === 'pending' || j.status === 'active')
  if (live.length) {
    lines.push('', ...live.map(j => {
      const status = j.status === 'active' ? 'sedang diunduh' : 'menunggu'
      const manual = j.manual ? ' [klaim .tt]' : ''
      const who = j.senderName ? ` — ${j.senderName}` : ''
      return `#${j.id} — ${providerLabel(j.provider)} — ${status}${manual}${who} — ${j.url}`
    }))
  }
  const recent = snap.recent ?? []
  if (recent.length) {
    const now = Date.now()
    lines.push('', `Cooldown (${recent.length}):`, ...recent.map(r => `• ${r.url} (${Math.max(0, Math.ceil((r.until - now) / 1000))} detik lagi)`))
  }
  if (!live.length && !recent.length) lines.push('', 'Antrean kosong.')
  await m.reply(lines.join('\n'))
}
handler.help = ['listqueue']
handler.tags = ['owner']
handler.command = /^(listqueue|lq)$/i
handler.founder = true
export default handler
