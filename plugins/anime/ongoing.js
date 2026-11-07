// plugins/anime/ongoing.js
//
// Daftar anime update terbaru (Kuramanime ongoing). Hasilnya disimpan
// sebagai tahap awal alur anime — lanjutkan dengan .pilih <nomor>
// untuk membuka episode terbaru judul itu dan memilih provider unduhan.

import { fetchOngoingPage } from '#lib/kuramanime/catalog.js'
import { setFlow, flowKey, formatOngoingView, assertAnimeAccess, assertAnimeCooldown, markAnimeUse, saveAnimeUser } from '#lib/helpers/animeFlow.js'

let handler = async (m, ctx) => {
  const { text } = ctx
  const access = assertAnimeAccess(m, ctx)
  if (!access.exempt) assertAnimeCooldown(ctx.userData)
  const page = Math.max(1, parseInt(String(text || '').trim(), 10) || 1)
  let result
  try {
    result = await fetchOngoingPage({ page })
  } catch (e) {
    throw `❌ Gagal mengambil daftar ongoing:\n${e.message || e}`
  }
  if (!result.items.length) throw '❌ Halaman ongoing kosong.'
  setFlow(flowKey(m), { stage: 'ongoing', items: result.items })
  if (!access.exempt) { markAnimeUse(ctx.userData); await saveAnimeUser() }
  return m.reply(formatOngoingView(result, page))
}

handler.help = ['ongoing [halaman]']
handler.tags = ['anime']
handler.command = /^ongoing$/i

export default handler
