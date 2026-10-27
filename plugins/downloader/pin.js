// plugins/downloader/pin.js
//
// .pin — permukaan khusus Pinterest (permintaan pemilik 2026-10-25).
//   .pin <link Pinterest/pin.it>  -> unduh via antrean .dl yang sama
//   .pin <kata kunci>             -> searching + download (MENYUSUL: butuh
//                                    jalur sesi Pinterest, lihat keputusan
//                                    pemilik — untuk sekarang ditolak jelas)
//   .pin antrean / .pin batal <id> -> antrean bersama .dl
//
// Sengaja mendelegasikan ke dlHandler, bukan menduplikasi logika antrean:
// antrean, dedupe, cooldown, dan pengiriman file .pin === .dl Pinterest.
// Satu-satunya yang ditambahkan plugin ini: gerbang domain (hanya
// Pinterest) dan cabang kata-kunci untuk search.

import { ensureEngines, downloaderRegistry } from '#lib/downloader/index.js'
import dlHandler, { extractDownloadUrl } from './download.js'

let handler = async (m, ctx) => {
  const text = String(ctx.text ?? '').trim()

  // Sub-perintah antrean: antrean .pin == antrean .dl (satu queue).
  if (/^(antrean|antri|status|batal)\b/i.test(text)) return dlHandler(m, { ...ctx, command: 'pin' })

  const url = extractDownloadUrl(text, m.quoted?.text, m.quoted?.caption)
  if (!url) {
    if (text) throw '🔍 Pencarian Pinterest berdasarkan kata kunci masih disiapkan — butuh jalur sesi Pinterest (keputusan menyusul). Untuk sekarang .pin hanya menerima link.'
    throw 'Kirim link Pinterest.\nContoh: .pin https://pin.it/xxxxxx'
  }

  await ensureEngines()
  const registry = ctx.downloaderRegistry ?? downloaderRegistry
  if (registry.detectProvider(url) !== 'pinterest') {
    throw 'Link ini bukan Pinterest. .pin khusus link Pinterest/pin.it — pakai .dl untuk platform lain.'
  }
  return dlHandler(m, { ...ctx, command: 'pin' })
}

handler.help = ['pin <link Pinterest>', 'pin antrean', 'pin batal <id>']
handler.tags = ['downloader']
handler.command = /^(pin|pinterest)$/i

export default handler
