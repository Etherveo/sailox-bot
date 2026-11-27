// Klien channel konversi stiker — sisi WORKER (sub-bot).
//
// Worker tidak boleh men-spawn proses (Node Permission Model tanpa
// --allow-child-process), jadi konversi ffmpeg dilempar ke bot utama
// lewat IPC 'sticker-convert' dan hasilnya kembali lewat 'sticker-result'.
// Media TIDAK PERNAH lewat IPC (batas 64 KB) — hanya manifest (nama file,
// sha256, ukuran, job); byte-nya lewat tmp dir sandbox sendiri.
//
// Alur requestConvert: validasi lapisan 1 (pure-JS, lib/subbot/
// mediaInspect.js) -> tulis input ke <sandbox>/tmp -> kirim manifest ->
// tunggu balasan (timeout) -> verifikasi balasan (path confinement,
// file reguler, sha256, magic bytes, ukuran) -> kembalikan buffer hasil.
// File tmp input+output selalu dibersihkan (finally).
//
// Transport diikat worker.js (initConvertClient) — modul ini sendiri
// tidak menyentuh process.send, supaya aman diimpor bot utama juga
// (di sana requestConvert tidak pernah dipanggil: plugin bercabang
// lewat conn.role === 'sub').
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { validateConvertInput, verifyStickerOutput, verifyAudioOutput } from './mediaInspect.js'
import { addExifToWebp, extractStickerMeta } from '../media/sticker.js'
import { validateBratText } from '../media/brat.js'

export const CONVERT_TIMEOUT_MS = 180000
export const CONVERT_REQUEST_TIMEOUT_TEXT = 'Konversi stiker kehabisan waktu (3 menit) — coba lagi.'

// Nama file hasil yang sah (dipakai verifikasi balasan DAN pencatatan
// untuk cleanup finally — jangan pernah rm nama file yang tidak cocok
// pola ini, karena path.join bisa keluar dari tmp).
const OUT_FILE_RE = /^conv-out-[0-9a-f]{16}\.(webp|ogg)$/

const pending = new Map()
let sendFn = null
let bratSendFn = null

export function initConvertClient(send) { sendFn = send }
export function initBratClient(send) { bratSendFn = send }

// Dipanggil dispatcher worker.js untuk pesan 'sticker-result'.
// Mengembalikan true bila ada request yang menunggu (dikenali).
export function handleConvertResult(msg) {
  const entry = pending.get(msg?.requestId)
  if (!entry) return false
  pending.delete(msg.requestId)
  clearTimeout(entry.timer)
  entry.resolve(msg)
  return true
}

const sha256hex = buf => crypto.createHash('sha256').update(buf).digest('hex')

// tmp dir sandbox: TMPDIR di-set launcher ke <sandbox>/tmp; fallback cwd.
function tmpDir() { return process.env.TMPDIR || path.join(process.cwd(), 'tmp') }

// Menunggu balasan 'sticker-result' untuk satu requestId — dipakai
// requestConvert DAN requestBrat (keduanya menunggu tipe balasan yang
// sama, dibedakan hanya oleh requestId). Mengembalikan { promise, timer };
// pemanggil yang mengirim pesan (di dalam executor, sesudah pending
// terpasang) dan membersihkan timer di finally-nya sendiri.
function waitForResult(requestId, send, timeoutMs) {
  let timer
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => { pending.delete(requestId); reject(new Error('CONVERT_TIMEOUT')) }, timeoutMs)
    timer.unref?.()
    pending.set(requestId, { resolve, reject, timer })
    Promise.resolve(send()).catch(e => { pending.delete(requestId); clearTimeout(timer); reject(e) })
  })
  return { promise, timer }
}

// Verifikasi balasan 'sticker-result' terhadap file di tmp sandbox:
// nama file cocok pola, file biasa, ukuran = yang diumumkan, sha256
// cocok, magic bytes WebP/OggS benar. Mengembalikan buffer hasil.
async function verifyResultFile(result, dir) {
  if (!result?.ok) throw String(result?.error || 'Konversi gagal di bot utama — coba lagi.')
  if (!['sticker', 'audio'].includes(result.media)) throw 'Balasan konversi tidak dikenal.'
  if (typeof result.file !== 'string' || !OUT_FILE_RE.test(result.file)) throw 'Balasan konversi tidak dikenal.'
  const outPath = path.join(dir, result.file)
  const st = await fs.lstat(outPath).catch(() => null)
  if (!st?.isFile() || st.size !== result.size) throw 'Balasan konversi tidak dikenal.'
  const out = await fs.readFile(outPath)
  if (sha256hex(out) !== result.sha256) throw 'Balasan konversi tidak cocok (hash).'
  if (result.media === 'sticker') verifyStickerOutput(out)
  else verifyAudioOutput(out)
  return { buffer: out, seconds: Number.isFinite(result.seconds) ? result.seconds : 0, media: result.media }
}

export async function requestConvert({ job, purpose, kind, buffer, seconds = 0, timeoutMs = CONVERT_TIMEOUT_MS } = {}) {
  if (!sendFn) throw new Error('Layanan konversi stiker belum diinisialisasi di worker ini.')
  if (!['sticker', 'sound-sticker'].includes(purpose)) throw 'Tujuan konversi tidak dikenal.'
  await validateConvertInput({ buffer, job, kind, seconds })
  const requestId = crypto.randomBytes(8).toString('hex')
  const dir = tmpDir()
  await fs.mkdir(dir, { recursive: true })
  const inputName = `conv-in-${requestId}.bin`
  const inputPath = path.join(dir, inputName)
  await fs.writeFile(inputPath, buffer, { flag: 'wx' })
  let outName = null
  let timer
  try {
    const waited = waitForResult(requestId, () => sendFn({ requestId, purpose, job, kind, file: inputName, sha256: sha256hex(buffer), size: buffer.length, seconds }), timeoutMs)
    timer = waited.timer
    const result = await waited.promise
    // Nama file aman (pola OUT_FILE_RE) -> catat untuk cleanup finally
    // walau verifikasi isi di bawah gagal.
    if (typeof result?.file === 'string' && OUT_FILE_RE.test(result.file)) outName = result.file
    return await verifyResultFile(result, dir)
  } catch (e) {
    if (e?.message === 'CONVERT_TIMEOUT') throw CONVERT_REQUEST_TIMEOUT_TEXT
    throw e
  } finally {
    clearTimeout(timer)
    await fs.rm(inputPath, { force: true }).catch(() => {})
    if (outName) await fs.rm(path.join(dir, outName), { force: true }).catch(() => {})
  }
}

// Render brat lewat bot utama ('brat-render' -> 'sticker-result').
//
// Inputnya TEKS (maks 150 karakter) — tidak perlu transfer file untuk
// input; yang kembali adalah stiker webp jadi, diverifikasi dengan cara
// yang SAMA seperti requestConvert (nama file, lstat, ukuran, sha256,
// magic bytes). pack/author TIDAK di-stamp di sini: nilainya tetap
// 'Brat'/nama bot dan sudah ditanam manager saat mediaToSticker.
export async function requestBrat(text, { timeoutMs = CONVERT_TIMEOUT_MS } = {}) {
  if (!bratSendFn) throw new Error('Layanan render brat belum diinisialisasi di worker ini.')
  const clean = validateBratText(text)
  const requestId = crypto.randomBytes(8).toString('hex')
  const dir = tmpDir()
  await fs.mkdir(dir, { recursive: true })
  let outName = null
  let timer
  try {
    const waited = waitForResult(requestId, () => bratSendFn({ requestId, text: clean }), timeoutMs)
    timer = waited.timer
    const result = await waited.promise
    if (typeof result?.file === 'string' && OUT_FILE_RE.test(result.file)) outName = result.file
    const verified = await verifyResultFile(result, dir)
    if (verified.media !== 'sticker') throw 'Balasan render brat bukan stiker.'
    return verified
  } catch (e) {
    if (e?.message === 'CONVERT_TIMEOUT') throw CONVERT_REQUEST_TIMEOUT_TEXT
    throw e
  } finally {
    clearTimeout(timer)
    if (outName) await fs.rm(path.join(dir, outName), { force: true }).catch(() => {})
  }
}

// Stempel pack/author ke stiker jadi — PURE-JS (edit chunk EXIF WebP,
// lib/media/sticker.js), supaya worker tetap tanpa child process.
// Hanya dipanggil bila user MEMBERIKAN pack/author; bila tidak, stiker
// dibiarkan apa adanya (EXIF kosong dari bot utama).
export function stampStickerMeta(sticker, { packname, author, emojis = [''] } = {}) {
  const meta = extractStickerMeta(sticker)
  return addExifToWebp(sticker, {
    packname,
    author,
    packId: meta?.['sticker-pack-id'] ?? `sailox-${crypto.randomBytes(8).toString('hex')}`,
    emojis,
  })
}
