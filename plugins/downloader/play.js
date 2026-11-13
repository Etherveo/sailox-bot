// plugins/downloader/play.js
//
// .play (alias .yta/.ytmp3/.mp3) — permukaan khusus YouTube (permintaan
// pemilik 2026-11-14, "banyak yang nyariin"). Diporting dari legacy
// plugins/downloader-play.js:
//   .play <judul lagu / link YouTube> -> cari video pertama (atau pakai
//   link yang ditempel) lalu unduh sebagai audio mp3.
//
// Sengaja mendelegasikan antrean ke dlHandler (pola yang sama seperti
// .pin): antrean, dedupe, cooldown, dan pengiriman file .play === .dl
// YouTube. Yang ditambahkan plugin ini: pencarian query via InnerTube
// (engine youtube) + balasan "video ditemukan" sebelum masuk antrean.
// Sub-perintah antrean (.play antrean / .play batal <id>) juga ikut
// didelegasikan — antrean .play == antrean .dl (satu queue).
//
// Gerbang audio (perintah pemilik 2026-11-14): durasi >1 jam ditolak
// (dari hasil pencarian, sebelum antre; untuk link langsung durasi
// dicek prosesor antrean di runJob — sesudah getInfo, sebelum unduh);
// flag -d di mana saja atau ukuran >15 MB -> kirim sebagai dokumen;
// ukuran >500 MB ditolak. Gerbang diteruskan ke dlHandler lewat
// ctx.jobOptions (diteruskan runJob sebagai job.options).

import dlHandler from './download.js'
import { searchYouTube, extractVideoId } from '#lib/downloader/engines/youtube.js'

function formatDuration(seconds) {
  const s = Number(seconds) || 0
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

function formatViews(n) {
  if (!n) return 'N/A'
  if (n >= 1000000) return (n / 1000000).toFixed(1) + ' jt'
  if (n >= 1000) return (n / 1000).toFixed(1) + ' rb'
  return n.toString()
}

// Batas audio .play (perintah pemilik 2026-11-14).
export const MAX_AUDIO_DURATION_SEC = 3600 // >1 jam ditolak
export const MAX_AUDIO_SIZE_BYTES = 500 * 1024 * 1024 // >500 MB ditolak
export const AUDIO_DOC_ABOVE_BYTES = 15 * 1024 * 1024 // >15 MB jadi dokumen

// Gerbang audio untuk job.options runJob (lihat runJob.js): -d paksa
// dokumen; >15 MB jadi dokumen; >1 jam / >500 MB ditolak.
export function playJobOptions({ forceDocument = false } = {}) {
  return {
    forceDocument,
    docAboveBytes: AUDIO_DOC_ABOVE_BYTES,
    maxDurationSec: MAX_AUDIO_DURATION_SEC,
    maxSizeBytes: MAX_AUDIO_SIZE_BYTES,
  }
}

let handler = async (m, ctx) => {
  const { text, usedPrefix, command } = ctx
  // Flag -d di mana saja (pola .gp -f / timer -p/-d): token mandiri '-d'
  // dibuang dari teks sebelum parsing apa pun.
  const tokens = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  const forceDocument = tokens.includes('-d')
  const raw = tokens.filter(t => t !== '-d').join(' ')

  // Sub-perintah antrean: antrean .play == antrean .dl (satu queue).
  if (/^(antrean|antri|status|batal)\b/i.test(raw)) return dlHandler(m, { ...ctx, command: 'play' })

  if (!raw) {
    throw (
      `🎵 *Cari & unduh audio YouTube*\n\n` +
      `${usedPrefix}${command} <judul lagu / link YouTube> [-d]\n\n` +
      `Contoh:\n${usedPrefix}${command} never gonna give you up\n${usedPrefix}${command} https://youtu.be/dQw4w9WgXcQ\n\n` +
      `Audio dikirim sebagai mp3 lewat antrean unduhan — cek dengan ${usedPrefix}dl antrean.\n` +
      `Tambah -d untuk kirim sebagai dokumen; audio di atas 15 MB otomatis jadi dokumen, di atas 1 jam / 500 MB ditolak.`
    )
  }

  const search = ctx.searchYouTube ?? searchYouTube
  let videoUrl
  let found = null
  if (/(youtube\.com|youtu\.be)/i.test(raw)) {
    const id = extractVideoId(raw)
    if (!id) throw '❌ Link YouTube tidak valid!'
    videoUrl = `https://youtu.be/${id}`
  } else {
    try {
      found = await search(raw)
    } catch (e) {
      // Error pencarian tampil apa adanya ke peminta (bukan pesan
      // internal generik): plugin melempar string, bukan Error.
      throw `❌ ${e?.message || e}`
    }
    if ((found.seconds || 0) > MAX_AUDIO_DURATION_SEC) {
      throw `❌ Durasi video ${formatDuration(found.seconds)} melebihi batas 1 jam untuk .play (audio).`
    }
    videoUrl = found.url
  }

  if (found) {
    await m.reply(
      `🎵 *${found.title}*\n` +
      `👤 ${found.author?.name || 'N/A'} • ⏱️ ${formatDuration(found.seconds)} • 👁️ ${formatViews(found.views)}\n` +
      `🔗 ${found.url}`
    )
  }

  return dlHandler(m, { ...ctx, command: 'play', text: videoUrl, jobOptions: playJobOptions({ forceDocument }), youtubeKind: 'audio' })
}

handler.help = ['play <judul lagu / link YouTube> [-d]', 'yta <judul lagu / link YouTube> [-d]', 'ytmp3 <judul lagu / link YouTube> [-d]', 'mp3 <judul lagu / link YouTube> [-d]', 'play antrean', 'play batal <id>']
handler.tags = ['downloader']
handler.command = /^(play|yta|ytmp3|mp3)$/i
handler.limit = 3

export default handler
