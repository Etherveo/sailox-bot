import path from 'node:path'
import { reactTo, REACT } from '#lib/helpers/react.js'
import { parseSmemeText, drawSmemeText } from '#lib/media/smeme.js'
import { mediaToSticker } from '#lib/media/sticker.js'
// .smeme teks_atas|teks_bawah -<ukuran> — gambar jadi stiker berteks
// meme (adaptasi sticker-smeme.js legacy): kirim perintahnya bersama
// gambar atau reply gambar. Ukuran font 10–120 ditulis sebagai sufiks
// " -90" (bawaan 70). Gambar saja — video tidak didukung, pakai .s.
// Non-gambar ditolak lewat TIGA sinyal sekaligus (seperti legacy yang
// memeriksa mimetype): mtype pesan, mediaType, dan mimetype konten —
// salah satu berbunyi video/teks, langsung ditolak.
let handler = async (m, { conn, text, __dirname }) => {
  const parsed = parseSmemeText(text)
  if (!parsed) throw 'Contoh: (reply gambar) .smeme teks_atas|teks_bawah — ukuran font pakai sufiks, mis. .smeme yang bener aja|rugi dong -90'
  const own = m.mtype === 'imageMessage' || m.mtype === 'stickerMessage' ? m : null
  const q = own ?? m.quoted
  const mime = q?.msg?.mimetype || ''
  const typeOk = q?.mtype === 'imageMessage' || q?.mtype === 'stickerMessage' || q?.mediaType === 'image' || q?.mediaType === 'sticker'
  const mimeOk = !mime || mime.startsWith('image/')
  if (!q || !typeOk || !mimeOk) throw 'Reply/kirim gambar dengan perintah .smeme — video/teks tidak bisa, kalau video pakai .s saja.'
  await reactTo(m, REACT.processing).catch(() => {})
  const buffer = await q.download()
  if (!buffer?.length) throw 'Gambarnya gagal diunduh — coba kirim ulang ya.'
  const root = path.resolve(__dirname, '..', '..')
  const drawn = await drawSmemeText(buffer, { root, ...parsed })
  const sticker = await mediaToSticker(drawn, { kind: 'image', root, packname: global.namebot || 'Sailox', author: global.namebot || 'Sailox' })
  await conn.sendMessage(m.chat, { sticker }, { quoted: m })
  await reactTo(m, REACT.done).catch(() => {})
}
handler.help = ['smeme <teks_atas>|<teks_bawah> [-ukuran]']; handler.tags = ['sticker']; handler.command = /^smeme$/i
export default handler
