import path from 'node:path'
import { reactTo, REACT } from '#lib/helpers/react.js'
import { parseStickerArgs, assertVideoLimits, mediaToSticker } from '#lib/media/sticker.js'
import { resolveMediaTarget, stickerKindFor, downloadMediaWithFallback, MediaGoneError } from '#lib/media/resolve.js'
import { requestConvert, stampStickerMeta } from '#lib/subbot/convertClient.js'
// Sticker maker: .s sambil mengirim gambar/video atau me-reply salah
// satunya. Watermark bisa langsung ditulis: .s <pack> | <author>
// (masing-masing maks 39 karakter; kosong = nama bot). Video harus
// berdurasi di bawah 10 detik dan berukuran maksimal 5 MB.
// Penerus sticker-sticker.js legacy, tapi konversi & EXIF 100% lokal
// (lihat lib/media/sticker.js) — tanpa API konversi eksternal.
// Sumber media (lib/media/resolve.js): pesan sendiri atau reply —
// gambar/video inline, dokumen gambar/video/GIF, dan pesan once-view
// (salinan quote once-view tidak membawa URL media, jadi unduhan jatuh
// ke pesan asli di store bot bila masih ada).
const toNum = v => {
  const n = v && typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v)
  return Number.isFinite(n) ? n : 0
}
let handler = async (m, { conn, text, __dirname }) => {
  // userWm = apa yang benar-benar diketik user (tanpa bawaan) — dipakai
  // untuk memutuskan apakah pack/author ditempel di sub-bot; wm = nilai
  // akhir dengan bawaan (Sailox/Velaryna) seperti biasa.
  const userWm = parseStickerArgs(text, {})
  const wm = { packname: userWm.packname || global.namebot || 'Sailox', author: userWm.author || 'Velaryna' }
  const target = resolveMediaTarget(m)
  const kind = stickerKindFor(target)
  if (!target || !kind) throw 'Kirim/reply gambar, video, GIF, atau dokumen gambar/video'
  const seconds = toNum(target.msg?.msg?.seconds)
  if (kind === 'video') assertVideoLimits({ seconds, bytes: toNum(target.msg?.msg?.fileLength) })
  await reactTo(m, REACT.processing).catch(() => {})
  let buffer
  try {
    buffer = await downloadMediaWithFallback(conn, target)
  } catch (e) {
    if (e instanceof MediaGoneError) throw e.message
    throw e
  }
  if (!buffer?.length) throw 'Medianya gagal diunduh — coba kirim ulang ya.'
  if (kind === 'video') assertVideoLimits({ seconds, bytes: buffer.length })
  // Sub-bot: worker tidak bisa spawn ffmpeg, jadi konversi dilempar ke
  // bot utama lewat channel IPC (auto-approve, validasi berlapis —
  // lib/subbot/convertClient.js). pack/author ditempel di sini (pure-JS)
  // HANYA bila user memberikannya; tanpa input, EXIF dari bot utama
  // dibiarkan apa adanya.
  if (conn.role === 'sub') {
    const converted = await requestConvert({ job: kind === 'video' ? 'sticker-video' : 'sticker-image', purpose: 'sticker', kind, buffer, seconds })
    let sticker = converted.buffer
    if (userWm.packname || userWm.author) sticker = stampStickerMeta(sticker, { packname: wm.packname, author: wm.author, emojis: [''] })
    await conn.sendMessage(m.chat, { sticker }, { quoted: m })
    await reactTo(m, REACT.done).catch(() => {})
    return
  }
  const sticker = await mediaToSticker(buffer, { kind, root: path.resolve(__dirname, '..', '..'), seconds, ...wm })
  await conn.sendMessage(m.chat, { sticker }, { quoted: m })
  await reactTo(m, REACT.done).catch(() => {})
}
handler.help = ['s (gambar/video/GIF/dokumen/once-view)', 's <pack> | <author>']; handler.tags = ['sticker']; handler.command = /^s(?:ti(?:c)?ker)?$/i
handler.limit = true
// Dibagikan ke sub-bot: konversi jalan lewat channel bot utama
// (lib/subbot/convertClient.js) — worker tetap tanpa child process.
handler.sharing = true
export default handler