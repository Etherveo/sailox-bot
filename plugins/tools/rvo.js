// Port tools-readviewonce.js legacy: kirim ulang media once-view
// (gambar/video/audio/dokumen) sebagai pesan biasa, tanpa once-view.
// Target: pesan yang di-reply, atau pesan sendiri bila tidak me-reply.
// Salinan quote once-view tidak membawa URL media (hanya thumbnail),
// jadi unduhan jatuh ke pesan asli di store bot bila masih ada
// (lihat lib/media/resolve.js). Bila asli sudah tidak ada, pesannya
// jelas: kirim ulang medianya.
import { resolveMediaTarget, downloadMediaWithFallback, MediaGoneError } from '#lib/media/resolve.js'

let handler = async (m, { conn }) => {
  const target = resolveMediaTarget(m)
  if (!target) throw 'Reply media once-view (gambar/video/audio/dokumen) dengan .rvo untuk mengirimnya lagi sebagai pesan biasa.'
  let buffer
  try {
    buffer = await downloadMediaWithFallback(conn, target)
  } catch (e) {
    if (e instanceof MediaGoneError) throw e.message
    throw 'Media gagal dimuat!'
  }
  if (!buffer?.length) throw 'Media gagal dimuat!'
  await conn.sendFile(m.chat, buffer, target.msg?.msg?.fileName || 'file', '', m)
}
handler.help = ['rvo (kirim ulang media once-view)']
handler.tags = ['tools']
handler.command = ['readviewonce', 'read', 'rvo', 'liat', 'readvo']
handler.limit = 3
export default handler
