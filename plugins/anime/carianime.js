// plugins/anime/carianime.js
//
// Pencarian anime di Kuramanime. Hasilnya disimpan sebagai tahap awal
// alur anime — .pilih <nomor> membuka detail judul (daftar episode),
// .pilih sekali lagi membuka pilihan provider unduhan episodenya.
//
// Format: .carianime <judul> [halaman]

import { searchAnime } from '#lib/kuramanime/catalog.js'
import { setFlow, flowKey, formatSearchView, assertAnimeAccess, assertAnimeCooldown, markAnimeUse, saveAnimeUser } from '#lib/helpers/animeFlow.js'

let handler = async (m, ctx) => {
  const { text, usedPrefix, command } = ctx
  const access = assertAnimeAccess(m, ctx)
  if (!access.exempt) assertAnimeCooldown(ctx.userData)
  const raw = String(text || '').trim()
  if (!raw) throw `🔍 Contoh: ${usedPrefix + command} li xiongmao`
  let keyword = raw
  let page = 1
  const parts = raw.split(/\s+/)
  if (parts.length > 1 && /^\d+$/.test(parts.at(-1))) {
    page = Math.max(1, parseInt(parts.at(-1), 10))
    keyword = parts.slice(0, -1).join(' ')
  }
  let result
  try {
    result = await searchAnime(keyword, { page })
  } catch (e) {
    throw `❌ Pencarian gagal:\n${e.message || e}`
  }
  if (!result.items.length) return m.reply(`🔍 Tidak ada hasil untuk "${keyword}". Coba kata kunci lain.`)
  setFlow(flowKey(m), { stage: 'search', items: result.items })
  if (!access.exempt) { markAnimeUse(ctx.userData); await saveAnimeUser() }
  return m.reply(formatSearchView(keyword, result))
}

handler.help = ['carianime <judul> [halaman]']
handler.tags = ['anime']
handler.command = /^carianime$/i

export default handler
