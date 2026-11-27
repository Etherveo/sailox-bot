// Layanan konversi stiker — sisi BOT UTAMA (manager).
//
// Worker tidak boleh men-spawn proses, jadi konversi ffmpeg dijalankan di
// sini atas permintaan IPC 'sticker-convert' (auto-approve — BUKAN antrean
// owner-approval plugin). Worker TIDAK dipercaya: manifest hanya klaim.
// Lapisan 2, dengan pendekatan yang BERBEDA dari lapisan 1 (header sniff
// di worker), sebelum apa pun diproses:
//   (a) path confinement — nama file saja, resolve di dalam tmp sandbox
//       peminta (sandboxPath: tolak traversal + symlink);
//   (b) salin file ke temp dir terisolasi milik bot utama — SEMUA langkah
//       berikut memakai SALINAN ini (anti-TOCTOU: worker tidak bisa
//       menukar file di tengah jalan);
//   (c) sha256 salinan harus cocok dengan manifest;
//   (d) sniff ulang magic bytes (jangan percaya tipe deklarasi) +
//       validasi lapisan-1 diulang terhadap byte salinan;
//   (e) ffprobe deep probe: stream/codec/durasi BENARAN, whitelist per
//       job — tolak stream tambahan (subtitle/attachment/data), stream
//       video ganda, durasi/dimensi absurd;
//   (f) re-encode DARI NOL via jalur yang sudah ada (mediaToSticker /
//       makeVideoSticker / toOggOpus) sehingga output hanya berisi
//       pixel/audio hasil encode baru — byte asli input tidak ada yang
//       lolos; kerja di temp dir terisolasi (mkdtemp), timeout + batas
//       output dari fungsi konversinya sendiri;
//   (g) kuota per sub-bot (maks bersamaan + maks per jam) supaya satu
//       sub-bot nakal tidak membanjiri ffmpeg (DoS proses utama).
//
// Hasil ditulis ke tmp sandbox peminta (flag 'wx', nama acak per request)
// lalu dibalas lewat IPC 'sticker-result'. Semua kegagalan dibalas
// ok:false dengan pesan user-facing (tanpa detail internal/path/stack).
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { sendIPC } from './ipc.js'
import { sandboxPath } from './sandbox.js'
import { mediaToSticker, makeVideoSticker, toOggOpus } from '../media/sticker.js'
import { sniffMedia, validateConvertInput, verifyStickerOutput, verifyAudioOutput } from './mediaInspect.js'
import { printError } from '../print.js'

const execFileP = promisify(execFile)

// Kuota per sub-bot (disimpan di record worker w — mati bersama worker).
export const CONVERT_MAX_CONCURRENT = 2
export const CONVERT_MAX_PER_HOUR = 30
const HOUR_MS = 3600000

const INPUT_FILE_RE = /^conv-in-[0-9a-f]{16}\.bin$/
const sha256hex = buf => crypto.createHash('sha256').update(buf).digest('hex')
function hashEqual(a, b) {
  const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex')
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y)
}

// Admission (dijalankan di dalam lock IPC manager — tanpa race).
// Mengembalikan null bila lolos, atau pesan penolakan (string).
export function admitConvert(w, now = Date.now()) {
  w.convertActive ??= 0
  w.convertWindow ??= []
  w.convertWindow = w.convertWindow.filter(t => now - t < HOUR_MS)
  if (w.convertActive >= CONVERT_MAX_CONCURRENT) return 'Terlalu banyak konversi bersamaan — coba lagi sebentar lagi.'
  if (w.convertWindow.length >= CONVERT_MAX_PER_HOUR) return 'Batas konversi stiker per jam tercapai — coba lagi nanti.'
  w.convertActive++
  w.convertWindow.push(now)
  return null
}

export function releaseConvert(w) {
  if (w.convertActive > 0) w.convertActive--
}

// ffprobe: baca stream + format sebenarnya (JSON). Hanya baca — tidak
// menulis apa pun ke file input.
export async function probeMedia(file) {
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { timeout: 15000, maxBuffer: 1024 * 1024 })
  const parsed = JSON.parse(stdout)
  if (!parsed || !Array.isArray(parsed.streams)) throw new Error('ffprobe tidak mengembalikan stream')
  return parsed
}

// Aturan stream per job. videoCodecs null = codec video apa pun boleh
// (ffmpeg yang menilai); audio = jumlah stream audio yang diizinkan
// (0 = tidak boleh ada, 1 = maks satu, -1 = wajib ada minimal satu).
const PROBE_RULES = {
  'sticker-image': { videoCodecs: ['png', 'mjpeg', 'webp', 'gif'], audio: 0, maxStreams: 1, maxWidth: 8000, maxHeight: 8000, maxSeconds: 0 },
  'sticker-video': { videoCodecs: null, audio: 1, maxStreams: 2, maxWidth: 4096, maxHeight: 4096, maxSeconds: 10, secondsOp: '>=' },
  'sa-video-sticker': { videoCodecs: null, audio: 1, maxStreams: 2, maxWidth: 4096, maxHeight: 4096, maxSeconds: 25, secondsOp: '>' },
  'sa-audio': { videoCodecs: null, audio: -1, maxStreams: 2, maxWidth: 0, maxHeight: 0, maxSeconds: 300, secondsOp: '>', needAudio: true },
}

// Periksa hasil ffprobe terhadap aturan job. Mengembalikan { duration }
// (0 bila tidak diketahui). Lempar Error bila ada yang tidak lolos.
export function checkProbe(job, probe) {
  const rules = PROBE_RULES[job]
  if (!rules) throw new Error('job tidak dikenal: ' + job)
  const streams = probe.streams
  if (streams.length === 0) throw new Error('media tidak berisi stream')
  if (streams.length > rules.maxStreams) throw new Error('terlalu banyak stream: ' + streams.length)
  let video = 0, audio = 0
  for (const s of streams) {
    if (s.codec_type === 'video') {
      video++
      if (rules.videoCodecs && !rules.videoCodecs.includes(s.codec_name)) throw new Error('codec video tidak diizinkan: ' + s.codec_name)
      if (rules.maxWidth && (s.width <= 0 || s.width > rules.maxWidth || s.height <= 0 || s.height > rules.maxHeight)) throw new Error('dimensi tidak wajar: ' + s.width + 'x' + s.height)
    } else if (s.codec_type === 'audio') {
      audio++
    } else {
      throw new Error('stream tidak diizinkan: ' + s.codec_type)
    }
  }
  if (rules.audio === 0 && audio > 0) throw new Error('stream audio tidak diizinkan untuk gambar')
  if (rules.audio === 1 && audio > 1) throw new Error('terlalu banyak stream audio')
  if (rules.needAudio && audio < 1) throw new Error('tidak ada stream audio')
  if (job === 'sticker-image' && video !== 1) throw new Error('gambar harus tepat 1 stream video')
  if ((job === 'sticker-video' || job === 'sa-video-sticker') && video !== 1) throw new Error('video harus tepat 1 stream video')
  const durations = [parseFloat(probe.format?.duration), ...streams.map(s => parseFloat(s.duration))].filter(Number.isFinite)
  const duration = durations.length ? Math.max(...durations) : 0
  if (rules.maxSeconds && duration > 0) {
    const over = rules.secondsOp === '>=' ? duration >= rules.maxSeconds : duration > rules.maxSeconds
    if (over) throw new Error('durasi ' + duration.toFixed(1) + ' detik melewati batas ' + rules.maxSeconds)
  }
  return { duration }
}

// Tangani satu request 'sticker-convert' dari worker id.
// DIPANGGIL TANPA await dari handler IPC manager (fire-and-forget) supaya
// konversi yang lambat tidak menahan lock IPC (heartbeat worker lain
// tetap jalan). Semua kegagalan dibalas ok:false; pengecualian tak
// terduga juga ditangkap di sini — jangan pernah lempar ke pemanggil.
export async function handleStickerConvert(manager, id, w, msg) {
  const requestId = msg.requestId
  const reply = payload => sendIPC(w.child, 'sticker-result', { requestId, ...payload }).catch(() => {})
  let workDir = null
  try {
    const sandbox = await sandboxPath(manager.botsRoot, id)
    // (a) Path confinement: hanya nama file yang diterima; resolve di
    // dalam tmp sandbox peminta (tolak traversal + symlink).
    if (typeof msg.file !== 'string' || !INPUT_FILE_RE.test(msg.file)) {
      await reply({ ok: false, error: 'Nama file konversi tidak valid.' })
      return
    }
    const inputPath = await sandboxPath(sandbox, path.join('tmp', msg.file))
    const st = await fs.lstat(inputPath).catch(() => null)
    if (!st?.isFile() || st.size !== msg.size) {
      await reply({ ok: false, error: 'File konversi tidak ditemukan atau ukurannya berubah.' })
      return
    }
    // (b) Salin ke temp dir terisolasi milik bot utama.
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-conv-'))
    const inputCopy = path.join(workDir, 'input')
    await fs.copyFile(inputPath, inputCopy)
    const input = await fs.readFile(inputCopy)
    if (input.length !== msg.size) {
      await reply({ ok: false, error: 'Ukuran file berubah saat disalin.' })
      return
    }
    // (c) Hash salinan harus cocok dengan manifest.
    if (!hashEqual(sha256hex(input), msg.sha256)) {
      await reply({ ok: false, error: 'Hash file tidak cocok dengan manifest — file mungkin ditukar.' })
      return
    }
    // (d) Sniff ulang + validasi lapisan-1 terhadap byte salinan.
    const sniffed = await sniffMedia(input)
    if (!sniffed || sniffed.kind !== msg.kind) {
      await reply({ ok: false, error: 'Jenis media tidak cocok dengan yang dideklarasikan.' })
      return
    }
    await validateConvertInput({ buffer: input, job: msg.job, kind: msg.kind, seconds: msg.seconds })
    // (e) ffprobe deep probe pada salinan.
    const probe = await probeMedia(inputCopy).catch(e => { throw new Error('ffprobe gagal membaca media: ' + (e?.message || e)) })
    const { duration } = checkProbe(msg.job, probe)
    // (f) Re-encode dari nol (jalur yang sudah ada). pack/author KOSONG
    // di sini — sub-bot yang menempelkannya nanti (pure-JS) bila user
    // memberikannya. Emoji 🔊 untuk sound-sticker supaya penandanya
    // tetap ada walau worker tidak me-re-stamp.
    const emojis = msg.purpose === 'sound-sticker' ? ['🔊'] : ['']
    let output, media, audioSeconds = 0
    if (msg.job === 'sticker-image') {
      output = await mediaToSticker(input, { kind: 'image', root: workDir, packname: '', author: '', emojis })
      media = 'sticker'
    } else if (msg.job === 'sticker-video') {
      output = await mediaToSticker(input, { kind: 'video', root: workDir, seconds: msg.seconds || duration, packname: '', author: '', emojis })
      media = 'sticker'
    } else if (msg.job === 'sa-video-sticker') {
      output = await makeVideoSticker(input, '', '', { root: workDir, emojis })
      media = 'sticker'
    } else if (msg.job === 'sa-audio') {
      const converted = await toOggOpus(input, { root: workDir })
      output = converted.ogg
      audioSeconds = converted.seconds || 0
      media = 'audio'
    } else {
      await reply({ ok: false, error: 'Jenis konversi tidak dikenal.' })
      return
    }
    if (media === 'sticker') verifyStickerOutput(output)
    else verifyAudioOutput(output)
    // Tulis hasil ke tmp sandbox (flag 'wx': gagal bila sudah ada —
    // jangan mengikuti symlink yang mungkin ditanam).
    const outName = `conv-out-${requestId}.${media === 'sticker' ? 'webp' : 'ogg'}`
    const outPath = await sandboxPath(sandbox, path.join('tmp', outName))
    await fs.writeFile(outPath, output, { flag: 'wx' })
    await reply({ ok: true, file: outName, sha256: sha256hex(output), size: output.length, media, seconds: media === 'audio' ? (audioSeconds || duration || msg.seconds || 0) : 0 })
  } catch (e) {
    // String = pesan user-facing dari validasi; selain itu jangan
    // bocorkan detail internal (path, stack) ke worker.
    const userMsg = typeof e === 'string' ? e : 'Konversi gagal di bot utama — coba lagi.'
    await reply({ ok: false, error: userMsg })
    printError(e, { module: 'sticker-convert', id })
  } finally {
    releaseConvert(w)
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
