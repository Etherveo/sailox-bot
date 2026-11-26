// .sa / .audiosticker — sound sticker: stiker + trek audio (ikon mute di
// pojok stiker = sound sticker asli WA, bukan stiker + audio terpisah).
// Cara pakai:
//   1. Reply foto dengan .sa, lalu reply VN/audio dengan .sa (maks 25 dtk,
//      dalam 60 dtk) — stiker dari foto, audio dari VN.
//   2. Reply video (maks 25 dtk) dengan .sa — langsung jadi stiker animasi
//      + audio dari video itu.
//   3. .sa batal — batalkan sesi foto yang sedang menunggu audio.
//   4. Custom pack: .sa <pack> | <author> (aturan .s: maks 39 karakter).
// Limit: handler.limit = true (biaya 1 per sound sticker terkirim).
// Langkah yang belum mengirim apa pun tidak makan limit (m.limit = 0):
// foto (hanya membuat sesi) dan .sa batal; VN/video yang terkirim
// membayar penuh.
//
// Port dari yue-bot/plugins/sticker-stickeraudio.js (SC Yue 24-11-2026,
// perintah Veo 2026-11-25). Triknya BUKAN dukungan Baileys — plugin Yue
// me-patch proto saat runtime: `audioMessage` disisipkan sebagai field 26
// di StickerMessage, lalu dibungkus `audioStickerMessage` (field 134,
// FutureProofMessage) dan dikirim via relayMessage. Patch yang sama
// dipakai di sini; sudah diverifikasi terhadap @whiskeysockets/baileys
// 7.0.0-rc14 yang dipakai Sailox: StickerMessage.encode & Message.encode
// ada sebagai fungsi, FutureProofMessage ada, dan relayMessage Sailox
// (dipakai juga plugins/group/swgc.js) bermuara ke encodeWAMessage ->
// proto.Message.encode, jadi patch ini ikut terpanggil di jalur kirim.
//
// Adaptasi Sailox (tanpa dependensi baru — sharp & node-webpmux TIDAK
// terpasang di Sailox, dan AGENTS.md §9 melarang tambah dependensi tanpa
// kebutuhan yang terbukti):
//   - impor Baileys dari @whiskeysockets/baileys, bukan @adiwajshing.
//   - stiker foto dibuat lib/media/sticker.js (mediaToSticker — ffmpeg +
//     EXIF lokal, sama seperti .s); stiker video dibuat ffmpeg langsung di
//     plugin ini (tangga fps/qv ala Yue) + addExifToWebp dari helper yang
//     sama. Media diambil resolveMediaTarget/downloadMediaWithFallback
//     (termasuk fallback store untuk once-view), bukan mesin download
//     buatan Yue — resolver Sailox sudah menangani audioMessage.
//   - sesi foto->audio di atas store sesi generik Sailox
//     (lib/helpers/sessionStore.js, TTL 60 dtk), bukan Map global.
//   - ffmpeg dipanggil via execFile + array argumen (AGENTS.md §4.7/§6),
//     bukan shell string seperti di plugin Yue.
//   - string yang dilempar = pesan ke pengirim (konvensi pipeline);
//     Error = kegagalan internal (laporan ke founder).
//   - EXIF stiker membawa emoji 🔊 seperti plugin Yue (opsi `emojis` di
//     lib/media/sticker.js; bawaan helper tetap [''] untuk pemakai lain).
// Perbedaan yang disengaja dari plugin Yue:
//   - alias `.sa` ditambahkan (bot Ainz yang Veo tunjuk pakai .sa; plugin
//     Yue sendiri tidak punya alias ini).
//   - video maks 25 dtk (batas audio WA), BUKAN 10 dtk seperti .s —
//     karena stiker videonya dibuat di plugin ini, batas 10 dtk
//     mediaToSticker tidak berlaku di jalur video.
//   - akses TERBUKA untuk semua (keputusan Veo 2026-11-25: gratis dulu);
//     plugin Yue premium-only, tapi di Sailox gerbang premiumnya dilepas.
//   - author bawaan 'Velaryna' (ubahan Veo sendiri di .s), bukan
//     'tiktok @ponta.gt' milik Yue.
//   - dokumen GIF masuk jalur foto (seperti plugin Yue yang menilai dari
//     mime image/gif), bukan jalur video — GIF tidak punya trek audio,
//     jadi tetap butuh sesi supaya pengguna bisa menempelkan VN.
// Gagal relay -> fallback kirim stiker + audio terpisah (ala Yue).
// Tes live masih wajib: kirim .sa di HP dan lihat ikon mute muncul.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { proto, prepareWAMessageMedia } from '@whiskeysockets/baileys'
import { reactTo, REACT } from '#lib/helpers/react.js'
import { createSessionStore } from '#lib/helpers/sessionStore.js'
import { parseStickerArgs, mediaToSticker, addExifToWebp, probeDurationSeconds, ffmpegAvailable, STICKER_SIZE } from '#lib/media/sticker.js'
import { resolveMediaTarget, stickerKindFor, downloadMediaWithFallback, MediaGoneError } from '#lib/media/resolve.js'

const execFileP = promisify(execFile)
export const MAX_DURATION = 25
export const SESSION_MS = 60000
// Emoji yang ditulis ke EXIF stiker (ikon 🔊 = penanda sound sticker).
const STICKER_EMOJIS = ['🔊']

// Sesi foto -> audio per chat+sender, kedaluwarsa 60 dtk (store generik
// Sailox: tanpa timer sendiri, kedaluwarsa malas saat dibaca).
const audioStickerSessions = createSessionStore({ ttlMs: SESSION_MS })

const toNum = v => {
  const n = v && typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v)
  return Number.isFinite(n) ? n : 0
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

// Patch proto runtime (inti trik sound sticker — lihat header). Sekali
// per proses; encode asli dipanggil dulu, lalu field tambahan ditulis
// dengan nomor field + wire type yang sama seperti plugin Yue (tag 210
// = field 26, tag 1074 = field 134). Pesan asli dipulihkan setelah
// encode supaya objek pemanggil tidak berubah.
export function patchProto() {
  const M = proto?.Message
  if (!M || M.__audioStickerPatched) return

  const stickerEncode = M.StickerMessage.encode
  M.StickerMessage.encode = function (message, writer) {
    const audio = message?.audioMessage
    const own = !!audio && has(message, 'audioMessage')
    if (own) delete message.audioMessage
    const w = stickerEncode.call(this, message, writer)
    if (own) {
      message.audioMessage = audio
      M.AudioMessage.encode(audio, w.uint32(210).fork()).ldelim()
    }
    return w
  }

  const messageEncode = M.encode
  M.encode = function (message, writer) {
    const asm = message?.audioStickerMessage
    const own = !!asm && has(message, 'audioStickerMessage')
    let stash
    if (own) {
      delete message.audioStickerMessage
      if (has(message, 'stickerMessage')) {
        stash = message.stickerMessage
        delete message.stickerMessage
      }
    }
    const w = messageEncode.call(this, message, writer)
    if (own) {
      message.audioStickerMessage = asm
      if (stash) message.stickerMessage = stash
      M.FutureProofMessage.encode(asm, w.uint32(1074).fork()).ldelim()
    }
    return w
  }

  M.__audioStickerPatched = true
}

const cleanup = (...files) => Promise.all(files.map(f => fs.rm(f, { force: true }).catch(() => {})))

// Audio apa pun -> OGG Opus mono 48kHz (format VN WA), dipotong 25 dtk.
async function toOggOpus(buffer, { root }) {
  const dir = path.join(root, 'tmp')
  await fs.mkdir(dir, { recursive: true })
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const input = path.join(dir, `sa-in-${stamp}`)
  const output = path.join(dir, `sa-out-${stamp}.ogg`)
  try {
    await fs.writeFile(input, buffer)
    const seconds = await probeDurationSeconds(input).catch(() => null)
    await execFileP('ffmpeg', ['-y', '-i', input, '-vn', '-map', '0:a:0', '-t', String(MAX_DURATION), '-af', 'aresample=48000:async=1:first_pts=0', '-c:a', 'libopus', '-b:a', '48k', '-vbr', 'on', '-compression_level', '10', '-ac', '1', '-ar', '48000', '-application', 'audio', '-f', 'ogg', output], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    const ogg = await fs.readFile(output)
    if (!ogg || ogg.length < 200) throw new Error('Jalur audio kosong atau terlalu pendek.')
    return { ogg, seconds: seconds ?? 0 }
  } finally {
    await cleanup(input, output)
  }
}

// Video (maks 25 dtk) -> stiker WebP animasi 512x512. Tangga fps/kualitas
// ala Yue supaya hasilnya muat di bawah 880 KB; EXIF ditulis helper
// Sailox (addExifToWebp) supaya watermark pack/author konsisten dengan .s.
async function makeVideoSticker(buffer, packname, author, { root }) {
  const dir = path.join(root, 'tmp')
  await fs.mkdir(dir, { recursive: true })
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const input = path.join(dir, `sa-vid-in-${stamp}.mp4`)
  const output = path.join(dir, `sa-vid-out-${stamp}.webp`)
  try {
    await fs.writeFile(input, buffer)
    let webp = null
    for (const [fps, qv] of [[10, 50], [8, 36], [6, 24], [5, 16], [4, 12], [3, 8]]) {
      // '-fps_mode passthrough' = '-vsync 0' versi baru (dihapus ffmpeg 9).
      await execFileP('ffmpeg', ['-y', '-i', input, '-t', String(MAX_DURATION), '-vf', `fps=${fps},scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=decrease,format=rgba,pad=${STICKER_SIZE}:${STICKER_SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1`, '-vcodec', 'libwebp', '-lossless', '0', '-compression_level', '6', '-q:v', String(qv), '-loop', '0', '-preset', 'picture', '-an', '-fps_mode', 'passthrough', output], { timeout: 90000, maxBuffer: 4 * 1024 * 1024 })
      webp = await fs.readFile(output)
      if (webp.length <= 880 * 1024) break
    }
    return addExifToWebp(webp, { packname, author, packId: `sailox-sa-${crypto.randomBytes(8).toString('hex')}`, emojis: STICKER_EMOJIS })
  } finally {
    await cleanup(input, output)
  }
}

function makeWaveform(seed, length = 64) {
  const wf = Buffer.alloc(length)
  for (let i = 0; i < length; i++) {
    const b = seed && seed.length ? seed[(i * 19 + 7) % seed.length] : i * 11
    wf[i] = 18 + (b % 76)
  }
  return wf
}

async function buildAudioMessage(conn, ogg, seconds) {
  const { audioMessage } = await prepareWAMessageMedia(
    { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true },
    { upload: conn.waUploadToServer }
  )
  audioMessage.seconds = Math.max(1, Math.min(MAX_DURATION, Math.round(seconds > 0 ? seconds : 5)))
  audioMessage.ptt = true
  audioMessage.mimetype = 'audio/ogg; codecs=opus'
  if (!audioMessage.waveform || !audioMessage.waveform.length) {
    audioMessage.waveform = makeWaveform(ogg)
  }
  return audioMessage
}

async function sendAudioSticker(conn, chat, sticker, animated, audioMessage) {
  patchProto()
  const prepared = await prepareWAMessageMedia(
    { sticker, isAnimated: animated },
    { upload: conn.waUploadToServer }
  )
  prepared.stickerMessage.isAnimated = !!animated
  prepared.stickerMessage.audioMessage = audioMessage
  const payload = {
    __proto__: prepared,
    audioStickerMessage: { message: prepared },
    messageContextInfo: { messageSecret: crypto.randomBytes(32) }
  }
  await conn.relayMessage(chat, payload, {})
}

// Relay gagal (mis. WA menolak formatnya) -> kirim stiker + audio
// terpisah supaya pengguna tetap dapat hasilnya, bukan error kosong.
async function deliver(conn, chat, sticker, animated, converted, quoted) {
  try {
    const audioMessage = await buildAudioMessage(conn, converted.ogg, converted.seconds)
    await sendAudioSticker(conn, chat, sticker, animated, audioMessage)
  } catch (e) {
    console.error('[audiosticker] relay gagal, kirim terpisah:', e?.message || e)
    await conn.sendMessage(chat, { sticker }, { quoted })
    await conn.sendMessage(chat, {
      audio: converted.ogg,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true
    }, { quoted })
  }
}

const USAGE = 'Cara penggunaan:\n\n1. Reply foto dengan .sa\n2. Reply voice note atau audio dengan .sa dalam 60 detik\n3. Untuk video, reply video dengan .sa (maksimal 25 detik)\n\nCustom pack:\n.sa NamaPack|Author\n\nBatalkan sesi:\n.sa batal'
const FAIL_DOWNLOAD = 'Gagal mengunduh media. Reply langsung ke pesan aslinya (bukan hasil forward) lalu coba lagi.'
const NO_AUDIO = 'File tidak berisi audio yang valid.'

let handler = async (m, { conn, text, __dirname }) => {
  const root = path.resolve(__dirname, '..', '..')
  const chat = m.chat
  const sender = m.sender
  const argText = String(text ?? '').trim()

  if (/^batal$/i.test(argText)) {
    const session = audioStickerSessions.get(chat, sender)
    if (!session) throw 'Tidak ada sesi yang aktif.'
    audioStickerSessions.delete(chat, sender)
    await reactTo(m, REACT.done).catch(() => {})
    m.limit = 0 // Pembatalan sesi tidak makan limit.
    return conn.sendMessage(chat, { text: 'Sesi Audio Sticker berhasil dibatalkan.' }, { quoted: m })
  }

  if (!await ffmpegAvailable()) throw 'ffmpeg tidak tersedia di server — .sa sedang nonaktif.'
  const wm = parseStickerArgs(argText, { packname: global.namebot || 'Sailox', author: 'Velaryna' })
  const target = resolveMediaTarget(m)
  if (!target) throw USAGE

  let buffer
  try {
    buffer = await downloadMediaWithFallback(conn, target)
  } catch (e) {
    if (e instanceof MediaGoneError) throw e.message
    throw e
  }
  if (!buffer?.length) throw FAIL_DOWNLOAD

  // Dokumen GIF tidak punya trek audio: samakan dengan plugin Yue yang
  // menilai dari mime image/gif — masuk jalur foto + sesi, supaya
  // pengguna tetap bisa menempelkan VN (stickerKindFor Sailox menilai
  // GIF sebagai 'video' demi animasi, tapi jalur video mengirim langsung
  // tanpa sesi).
  const kind = target.mtype === 'documentMessage' && target.mime === 'image/gif' ? 'image' : stickerKindFor(target)

  // 1) Foto/dokumen gambar/stiker -> simpan sesi, tunggu VN/audio.
  if (kind === 'image') {
    await reactTo(m, '🎨').catch(() => {})
    const sticker = await mediaToSticker(buffer, { kind: 'image', root, ...wm, emojis: STICKER_EMOJIS })
    audioStickerSessions.put(chat, sender, { sticker, animated: false })
    await reactTo(m, REACT.done).catch(() => {})
    m.limit = 0 // Langkah ini hanya membuat sesi — limit baru dipotong saat VN/video terkirim.
    return conn.sendMessage(chat, { text: 'Foto diterima! Sekarang reply voice note atau audio dengan .sa dalam 60 detik.' }, { quoted: m })
  }

  // 2) Video (maks 25 dtk) -> stiker animasi + audio dari video, langsung.
  if (kind === 'video') {
    const seconds = toNum(target.msg?.msg?.seconds)
    if (seconds > MAX_DURATION) throw `Durasi video maksimal ${MAX_DURATION} detik.`
    await reactTo(m, '🎬').catch(() => {})
    const sticker = await makeVideoSticker(buffer, wm.packname, wm.author, { root })
    let converted = null
    try { converted = await toOggOpus(buffer, { root }) } catch {}
    if (!converted) {
      await reactTo(m, REACT.done).catch(() => {})
      return conn.sendMessage(chat, { sticker }, { quoted: m })
    }
    await deliver(conn, chat, sticker, true, converted, m)
    await reactTo(m, REACT.done).catch(() => {})
    return
  }

  // 3) VN/audio -> gabungkan dengan foto dari sesi yang aktif.
  if (target.mtype === 'audioMessage') {
    const session = audioStickerSessions.get(chat, sender)
    if (!session) throw 'Reply foto dengan .sa terlebih dahulu, lalu reply voice note atau audio dengan .sa.'
    await reactTo(m, '🎵').catch(() => {})
    let converted
    try {
      converted = await toOggOpus(buffer, { root })
    } catch {
      await reactTo(m, REACT.error).catch(() => {})
      throw NO_AUDIO
    }
    audioStickerSessions.delete(chat, sender)
    await deliver(conn, chat, session.sticker, session.animated, converted, m)
    await reactTo(m, REACT.done).catch(() => {})
    return
  }

  throw USAGE
}
handler.help = ['sa (sound sticker: reply foto lalu VN/audio, atau reply video)', 'sa <pack> | <author>']
handler.tags = ['sticker']
handler.command = /^s(?:ti(?:c)?ker)?a(?:udio)?$/i
handler.limit = true
export default handler
