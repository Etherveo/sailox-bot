// plugins/anime/anime.js
//
// Pintu masuk langsung fitur anime: tempel SATU link Kuramanime saja.
// - Link episode/batch -> langsung daftar provider unduhan episodenya.
// - Link detail anime  -> daftar episode/batch-nya.
// Lanjutkan dengan .pilih <nomor>. Tidak perlu menyalin link kDrive
// atau link episode terpisah seperti alur .unduh manual.

import { fetchAnimeDetail } from '#lib/kuramanime/catalog.js'
import { setFlow, flowKey, formatEpisodesView, openEpisodeFlow, ensureEngines } from '#lib/helpers/animeFlow.js'

let handler = async (m, { text, usedPrefix, command }) => {
  const url = String(text || '').trim().split(/\s+/)[0]
  if (!url) {
    throw (
      `🎬 *Contoh penggunaan:*\n${usedPrefix + command} https://v20.kuramanime.ing/anime/5139/li-xiongmao/episode/15\n\n` +
      'Tempel link EPISODE untuk langsung memilih provider unduhan, atau link DETAIL anime untuk melihat daftar episodenya.\n' +
      'Atau mulai dari *.ongoing* / *.carianime <judul>*.'
    )
  }
  let parsed
  try { parsed = new URL(url) } catch { throw '❌ URL tidak valid.' }
  if (!/(^|\.)kuramanime\./i.test(parsed.hostname)) throw '❌ Link ini bukan link Kuramanime.'

  await ensureEngines()

  try {
    if (/\/(episode|batch)\//i.test(parsed.pathname)) {
      const res = await openEpisodeFlow(url)
      if (res.flow) setFlow(flowKey(m), res.flow)
      return m.reply(res.text)
    }
    // Link detail anime -> daftar episode/batch
    const detail = await fetchAnimeDetail(url)
    const combined = [
      ...(detail.episodeList || []).map(e => ({ label: e.label, url: e.url })),
      ...(detail.batchList || []).map(b => ({ label: `Batch — ${b.label}`, url: b.url }))
    ]
    if (!combined.length) return m.reply(`🎬 *${detail.title || 'Anime'}*\n\nBelum ada episode/batch tersedia untuk judul ini.`)
    setFlow(flowKey(m), { stage: 'episodes', title: detail.title, items: combined })
    return m.reply(formatEpisodesView({ ...detail, _combined: combined }))
  } catch (e) {
    throw `❌ Gagal membuka link:\n${e.message || e}`
  }
}

handler.help = ['anime <link episode/detail kuramanime>']
handler.tags = ['anime']
handler.command = /^anime$/i
handler.founder = true

export default handler
