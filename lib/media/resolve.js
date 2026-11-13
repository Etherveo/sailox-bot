// Resolver media untuk perintah yang bekerja dari pesan sendiri / reply:
// .s (sticker) dan .rvo (kirim ulang once-view). Dipakai dua plugin dengan
// logic yang sama persis, jadi tinggal di sini (§12: engine bersama).
//
// Kenapa perlu fallback store: salinan quote pesan once-view pada
// umumnya membawa URL media, TAPI ada varian yang tidak (hanya thumbnail)
// — repro 2026-11-12: download salinan quote tanpa URL gagal 'No valid
// media URL or directPath present in message', padahal pesan aslinya punya
// URL lengkap. Jadi bila unduhan dari salinan quote gagal, ambil pesan
// asli dari store bot lewat stanzaId (pola getQuotedObj legacy). Store
// menyimpan pesan 6 jam (messageTTL), jadi fallback hanya bekerja selama
// itu dan selama bot tidak restart di antaranya.
// Format ASLI once-view (hasil eval m.quoted Veo 2026-11-13):
// quote once-view adalah media telanjang (imageMessage/videoMessage)
// dengan flag viewOnce:true — BUKAN bungkusan viewOnceMessageV2 — dan
// LENGKAP dengan url + mediaKey + directPath, jadi unduhan langsung dari
// quote bisa jalan. Bentuk bungkusan V2 tetap ditangani (normalize
// Baileys mengurainya); fallback store hanya jaring pengaman.
// Batasan alur (koreksi Veo, tes live di bot Sailox + yue 2026-11-13):
// pesan once-view yang dikirim DENGAN caption command (mis. '.s') sama
// sekali tidak terlihat bot (tidak masuk log, tidak direspon) — alur yang
// didukung: kirim media once-view terpisah, lalu reply dengan .s/.rvo.
import { smsg } from '../simple.js'

const MEDIA_MTYPES = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage']

// Media yang tidak lagi bisa diambil (asli tidak ada di store).
export class MediaGoneError extends Error {}

// Cari target media: pesan sendiri dulu, lalu yang di-reply.
// Mengembalikan { msg, via, mtype, mediaType, mime } atau null.
export function resolveMediaTarget(m) {
  for (const [msg, via] of [[m, 'own'], [m.quoted, 'quoted']]) {
    if (!msg || !MEDIA_MTYPES.includes(msg.mtype) || !msg.mediaMessage) continue
    return { msg, via, mtype: msg.mtype, mediaType: msg.mediaType, mime: msg.msg?.mimetype ?? null }
  }
  return null
}

// Jenis stiker untuk target: 'image' | 'video' | null (tidak bisa distiker).
// Dokumen dinilai dari mimetype (fallback ekstensi nama file): GIF jadi
// 'video' supaya animasinya kebawa, bukan frame pertama saja.
export function stickerKindFor(target) {
  if (!target) return null
  const { mtype, mime } = target
  if (mtype === 'videoMessage') return 'video'
  if (mtype === 'imageMessage' || mtype === 'stickerMessage') return 'image'
  if (mtype === 'documentMessage') {
    if (mime === 'image/gif') return 'video'
    if (mime?.startsWith('image/')) return 'image'
    if (mime?.startsWith('video/')) return 'video'
    const ext = String(target.msg?.msg?.fileName ?? '').split('.').pop()?.toLowerCase()
    if (['gif', 'mp4', 'mov', 'webm', 'mkv'].includes(ext)) return 'video'
    if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return 'image'
  }
  return null
}

// Unduh media target. Bila target dari reply dan unduhan salinan quote
// gagal, coba pesan asli dari store (sekali). Bila asli tidak ada di
// store, lempar MediaGoneError (pesan user-facing). Error lain dari
// percobaan terakhir dibiarkan naik apa adanya.
export async function downloadMediaWithFallback(conn, target) {
  let buffer
  try {
    buffer = await target.msg.download()
    return buffer
  } catch (e) {
    if (target.via !== 'quoted') throw e
    const id = target.msg?.id
    const original = id ? (conn.loadMessage?.(id) ?? conn.store?.loadMessage?.(id)) : undefined
    if (!original) throw new MediaGoneError('Media tidak lagi tersedia di penyimpanan bot (mungkin bot restart atau pesan sudah lebih dari 6 jam). Kirim ulang medianya ya.')
    return smsg(conn, original).download()
  }
}
