// .toimg — reply stiker jadi gambar, tanpa resize (HD, apa adanya).
// Stiker statis: WebP -> PNG lewat ffmpeg (tanpa filter scale).
// Stiker animasi: WebP -> GIF lewat Pillow (decoder WebP bawaan ffmpeg
// tidak bisa membaca WebP animasi — lihat lib/media/sticker.js), lalu
// dikirim sebagai GIF supaya animasinya kebawa.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { reactTo, REACT } from '#lib/helpers/react.js'
import { resolveMediaTarget, downloadMediaWithFallback, MediaGoneError } from '#lib/media/resolve.js'
import { isAnimatedWebp, webpAnimatedToGif, ffmpegAvailable } from '#lib/media/sticker.js'

const execFileP = promisify(execFile)

async function webpToPng(buffer, { root }) {
  const dir = path.join(root, 'tmp')
  await fs.mkdir(dir, { recursive: true })
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const input = path.join(dir, `toimg-in-${stamp}.webp`)
  const output = path.join(dir, `toimg-out-${stamp}.png`)
  try {
    await fs.writeFile(input, buffer)
    await execFileP('ffmpeg', ['-y', '-i', input, '-frames:v', '1', output], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    return fs.readFile(output)
  } finally {
    await fs.rm(input, { force: true }).catch(() => {})
    await fs.rm(output, { force: true }).catch(() => {})
  }
}

let handler = async (m, { conn, __dirname }) => {
  const target = resolveMediaTarget(m)
  if (!target || target.mtype !== 'stickerMessage') throw 'Reply stiker dengan .toimg untuk mengubahnya jadi gambar.'
  if (!await ffmpegAvailable()) throw 'ffmpeg tidak tersedia di server — .toimg sedang nonaktif.'
  await reactTo(m, REACT.processing).catch(() => {})
  let buffer
  try {
    buffer = await downloadMediaWithFallback(conn, target)
  } catch (e) {
    if (e instanceof MediaGoneError) throw e.message
    throw e
  }
  if (!buffer?.length) throw 'Stikernya gagal diunduh — coba kirim ulang ya.'
  const root = path.resolve(__dirname, '..', '..')
  if (isAnimatedWebp(buffer)) {
    const { gif } = await webpAnimatedToGif(buffer, { root })
    await conn.sendMessage(m.chat, { video: gif, gifPlayback: true }, { quoted: m })
  } else {
    const png = await webpToPng(buffer, { root })
    await conn.sendMessage(m.chat, { image: png }, { quoted: m })
  }
  await reactTo(m, REACT.done).catch(() => {})
}
handler.help = ['toimg (reply stiker → gambar)']
handler.tags = ['sticker']
handler.command = ['toimg']
handler.limit = 3
export default handler
