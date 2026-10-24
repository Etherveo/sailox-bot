import path from 'node:path'
import { reactTo, REACT } from '#lib/helpers/react.js'
import { parseStickerArgs, assertVideoLimits, mediaToSticker } from '#lib/media/sticker.js'
// Sticker maker: .s sambil mengirim gambar/video atau me-reply salah
// satunya. Watermark bisa langsung ditulis: .s <pack> | <author>
// (masing-masing maks 39 karakter; kosong = nama bot). Video harus
// berdurasi di bawah 10 detik dan berukuran maksimal 5 MB.
// Penerus sticker-sticker.js legacy, tapi konversi & EXIF 100% lokal
// (lihat lib/media/sticker.js) — tanpa API konversi eksternal.
const toNum = v => {
  const n = v && typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v)
  return Number.isFinite(n) ? n : 0
}
let handler = async (m, { conn, text, __dirname }) => {
  const wm = parseStickerArgs(text, { packname: global.namebot || 'Sailox', author: global.namebot || 'Sailox' })
  const own = ['imageMessage', 'videoMessage'].includes(m.mtype) ? m : null
  const q = own ?? m.quoted
  const kind = q?.mtype === 'videoMessage' ? 'video' : ['imageMessage', 'stickerMessage'].includes(q?.mtype) ? 'image' : null
  if (!q || !kind) throw 'Kirim/reply gambar atau video (di bawah 10 detik, maks 5 MB) dengan perintah .s — watermark sekalian juga bisa: .s Nama Pack | Author'
  const seconds = toNum(q.msg?.seconds)
  if (kind === 'video') assertVideoLimits({ seconds, bytes: toNum(q.msg?.fileLength) })
  await reactTo(m, REACT.processing).catch(() => {})
  const buffer = await q.download()
  if (!buffer?.length) throw 'Medianya gagal diunduh — coba kirim ulang ya.'
  if (kind === 'video') assertVideoLimits({ seconds, bytes: buffer.length })
  const sticker = await mediaToSticker(buffer, { kind, root: path.resolve(__dirname, '..', '..'), seconds, ...wm })
  await conn.sendMessage(m.chat, { sticker }, { quoted: m })
  await reactTo(m, REACT.done).catch(() => {})
}
handler.help = ['s (kirim/reply gambar/video)', 's <pack> | <author>']; handler.tags = ['sticker']; handler.command = ['s', 'sticker', 'stiker']
export default handler
