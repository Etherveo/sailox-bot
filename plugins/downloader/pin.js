// plugins/downloader/pin.js
//
// .pin — permukaan khusus Pinterest (permintaan pemilik 2026-10-25).
//   .pin <link Pinterest/pin.it>  -> unduh via antrean .dl yang sama
//   .pin <kata kunci>             -> cari via BaseSearchResource lalu kirim
//                                    hasilnya (1 = gambar + caption;
//                                    >1 = album, maks 5; jumlah lewat angka
//                                    di depan query, mis. .pin 3 wallpaper anime)
//   .pin antrean / .pin batal <id> -> antrean bersama .dl
//
// Pencarian memakai sesi dummy (BUKAN kredensial): endpoint Pinterest hanya
// memeriksa keberadaan + kecocokan csrftoken di Cookie vs header
// x-csrftoken — pasangan dummy lolos dan hasilnya penuh (terverifikasi
// 2026-11-14 dari VM; hasil identik dengan pasangan dari legacy
// internet-pinvid.js). Detail di lib/downloader/engines/pinterest.js.
//
// Sengaja mendelegasikan unduhan link ke dlHandler, bukan menduplikasi
// logika antrean: antrean, dedupe, cooldown, dan pengiriman file .pin
// === .dl Pinterest. Yang ditambahkan plugin ini: gerbang domain (hanya
// Pinterest) dan cabang kata-kunci untuk search.

import { ensureEngines, downloaderRegistry } from '#lib/downloader/index.js'
import { searchPins } from '#lib/downloader/engines/pinterest.js'
import dlHandler, { extractDownloadUrl } from './download.js'

const MAX_SEARCH_RESULTS = 5

// `.pin 3 wallpaper anime` -> { count: 3, query: 'wallpaper anime' }.
// Angka di depan hanya jadi jumlah bila > 0 (ala legacy); `.pin 0 x`
// tetap mencari '0 x', `.pin 3` saja -> query kosong (ditolak pemanggil).
function parseSearchArgs(text) {
  const args = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  let count = 1
  if (args.length && /^\d+$/.test(args[0]) && parseInt(args[0], 10) > 0) {
    count = parseInt(args[0], 10)
    args.shift()
  }
  return { count, query: args.join(' ') }
}

async function sendSearchResults(m, conn, query, results) {
  if (results.length === 1) {
    const r = results[0]
    const caption =
      `📌 *Pinterest Search*\n\n` +
      `- 📝 Query: ${query}\n` +
      `- 🎨 Title: ${r.title || 'Tanpa judul'}\n` +
      `- 👤 Uploader: ${r.pinner || 'Unknown'}\n` +
      `- 🔗 Link: ${r.pinUrl || r.imageUrl}`
    await conn.sendMessage(m.chat, { image: { url: r.imageUrl }, caption }, { quoted: m })
    return
  }
  // Album ala runJob: satu pesan parent {album} lalu tiap media membawa
  // albumParentKey; bila parent gagal, media dikirim satu per satu.
  const caption = `📌 *Pinterest Search*\n\n- 🔍 Query: ${query}\n- 📊 Total: ${results.length} gambar`
  let parentKey = null
  try {
    const parent = await conn.sendMessage(m.chat, { album: { expectedImageCount: results.length, expectedVideoCount: 0 } }, { quoted: m })
    parentKey = parent?.key ?? null
  } catch { parentKey = null }
  for (const [i, r] of results.entries()) {
    await conn.sendMessage(m.chat, {
      image: { url: r.imageUrl },
      caption: i === 0 ? caption : '',
      ...(parentKey ? { albumParentKey: parentKey } : {}),
    }, { quoted: m })
  }
}

let handler = async (m, ctx) => {
  const text = String(ctx.text ?? '').trim()

  // Sub-perintah antrean: antrean .pin == antrean .dl (satu queue).
  if (/^(antrean|antri|status|batal)\b/i.test(text)) return dlHandler(m, { ...ctx, command: 'pin' })

  const url = extractDownloadUrl(text, m.quoted?.text, m.quoted?.caption)
  if (!url) {
    if (!text) throw 'Kirim link Pinterest.\nContoh: .pin https://pin.it/xxxxxx'
    // Kata kunci (bukan link): pencarian Pinterest.
    const { count, query } = parseSearchArgs(text)
    if (count > MAX_SEARCH_RESULTS) throw 'Waduh, kebanyakan! Maksimum 5 foto aja ya.'
    if (!query) throw 'Kasih kata kunci pencariannya dong.\nContoh: .pin wallpaper anime'
    const searchFn = ctx.pinterestSearch ?? searchPins
    const results = await searchFn(query, { pageSize: 10 })
    const valid = (results ?? []).filter(r => r?.imageUrl).slice(0, count)
    if (!valid.length) throw `Query "${query}" ga ketemu di Pinterest, coba yang lain ya!`
    await sendSearchResults(m, ctx.conn, query, valid)
    return
  }

  await ensureEngines()
  const registry = ctx.downloaderRegistry ?? downloaderRegistry
  if (registry.detectProvider(url) !== 'pinterest') {
    throw 'Link ini bukan Pinterest. .pin khusus link Pinterest/pin.it — pakai .dl untuk platform lain.'
  }
  return dlHandler(m, { ...ctx, command: 'pin' })
}

handler.help = ['pin <link Pinterest>', 'pin <kata kunci>', 'pin <jumlah> <kata kunci>', 'pin antrean', 'pin batal <id>']
handler.tags = ['downloader']
handler.command = /^(pin|pinterest)$/i

export default handler
