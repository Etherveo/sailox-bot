// .pay / .qris — kirim gambar QRIS (src/public/images/Payment.jpg).
// .setqris — owner mengganti gambar QRIS: kirim gambar dengan caption
// .setqris, atau reply gambar lalu ketik .setqris.
// Satu file untuk ketiga perintah (AGENTS.md §12): jalur file QRIS
// cuma ada di satu tempat, dan .setqris menimpa file yang sama yang
// .pay kirim.
//
// Spek Veo 2026-11-25: ".pay (atau .qris) — hasilnya bot ngirim file
// QRIS; owner bisa ganti gambarnya via .setqris sambil kirim/reply
// gambar."
//
// Catatan gerbang: plugin ini TIDAK memasang handler.owner — .pay/.qris
// untuk semua orang (bebas limit — keputusan Veo 2026-11-25), sedangkan
// .setqris digerbang di dalam handler lewat ctx.isOwner. Kalau
// handler.owner dipasang, pipeline akan menolak non-owner untuk .pay
// juga. (Pola yang sama dipakai plugins/owner/ryn.js: gerbang founder lewat
// config.)
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveMediaTarget, downloadMediaWithFallback } from '#lib/media/resolve.js'

const DEFAULT_QRIS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'public', 'images', 'Payment.jpg')

// Jalur file QRIS — bisa ditimpa tes lewat setQrisPath supaya tes
// .setqris tidak pernah menyentuh Payment.jpg asli.
let qrisPath = DEFAULT_QRIS_PATH
export function setQrisPath(p) { qrisPath = p }
export function getQrisPath() { return qrisPath }

// Target media yang boleh jadi QRIS: foto (imageMessage) atau dokumen
// gambar (mimetype image/*, atau ekstensi gambar bila mime kosong).
// Video, audio, stiker, dan dokumen non-gambar ditolak — QRIS yang
// dikirim .pay harus gambar, bukan stiker/video.
function isImageTarget(target) {
  if (!target) return false
  const { mtype, mime } = target
  if (mtype === 'imageMessage') return true
  if (mtype === 'documentMessage') {
    if (mime?.startsWith('image/')) return true
    const ext = String(target.msg?.msg?.fileName ?? '').split('.').pop()?.toLowerCase()
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) return true
  }
  return false
}

async function sendQris(m, { conn }) {
  const stat = await fs.stat(qrisPath).catch(() => null)
  if (!stat) throw 'Gambar QRIS belum tersedia. Owner bisa mengaturnya lewat .setqris.'
  await conn.sendFile(m.chat, qrisPath, 'QRIS.jpg', '', m)
}

async function setQris(m, { conn, isOwner }) {
  if (!isOwner) throw 'Perintah ini khusus owner.'
  const target = resolveMediaTarget(m)
  if (!target) throw 'Kirim/reply gambar QRIS-nya dulu. Caranya: kirim gambar dengan caption .setqris, atau reply gambar lalu ketik .setqris.'
  if (!isImageTarget(target)) throw 'Yang dikirim bukan gambar. .setqris hanya menerima gambar (foto atau dokumen gambar).'
  const buffer = await downloadMediaWithFallback(conn, target)
  if (!buffer?.length) throw 'Gagal mengunduh gambar. Coba kirim ulang gambarnya.'
  // Tulis ke file sementara dulu lalu rename, supaya Payment.jpg tidak
  // pernah setengah tertulis bila proses mati di tengah jalan.
  const tmp = path.join(path.dirname(qrisPath), `.Payment.jpg.tmp-${process.pid}-${Date.now()}`)
  try {
    await fs.writeFile(tmp, buffer)
    await fs.rename(tmp, qrisPath)
  } catch (e) {
    await fs.unlink(tmp).catch(() => {})
    throw e
  }
  await m.reply(`Gambar QRIS berhasil diganti (${(buffer.length / 1024).toFixed(0)} KB).`)
}

let handler = async (m, ctx) => {
  if (ctx.command === 'setqris') return setQris(m, ctx)
  return sendQris(m, ctx)
}
handler.help = ['pay', 'qris', 'setqris']
handler.tags = ['info']
handler.command = /^(pay|qris|setqris)$/i
export default handler
