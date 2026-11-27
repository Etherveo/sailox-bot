// tests/subbotStickerConvert.test.js — channel konversi stiker sub-bot
// (opsi (a) yang disetujui Veo 2026-11-27): worker melempar konversi
// ffmpeg ke bot utama lewat IPC 'sticker-convert'/'sticker-result',
// auto-approve, validasi berlapis.
//
// Lapisan 1 (worker, pure-JS — lib/subbot/mediaInspect.js + klien):
// sniff magic bytes, batas ukuran, dimensi header, durasi metadata.
// Lapisan 2 (bot utama — lib/subbot/convertService.js, pendekatan
// BERBEDA): path confinement, salin ke temp terisolasi (anti-TOCTOU),
// sha256 vs manifest, sniff ulang, ffprobe deep probe (whitelist
// stream/codec/durasi), re-encode dari nol, kuota per sub-bot.
// pack/author ditempel SUB-BOT (pure-JS, stampStickerMeta) hanya bila
// user memberikannya.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EventEmitter } from 'node:events'
import { setImmediate as tick } from 'node:timers/promises'
import { validIPC } from '../lib/subbot/ipc.js'
import { sniffMedia, parseImageDimensions, validateConvertInput, verifyStickerOutput, verifyAudioOutput } from '../lib/subbot/mediaInspect.js'
import { initConvertClient, handleConvertResult, requestConvert, stampStickerMeta } from '../lib/subbot/convertClient.js'
import { admitConvert, releaseConvert, checkProbe, probeMedia, handleStickerConvert, CONVERT_MAX_CONCURRENT, CONVERT_MAX_PER_HOUR } from '../lib/subbot/convertService.js'
import { parseStickerArgs, extractStickerMeta, ffmpegAvailable } from '../lib/media/sticker.js'
import { SubBotManager } from '../lib/subbot/manager.js'
import { Database } from '../lib/database/engine.js'
import { fakeConn, PN, LID, BOTLID } from './fixtures.js'
import stickerHandler from '../plugins/sticker/sticker.js'
import saHandler from '../plugins/sticker/stickeraudio.js'

const execFileP = promisify(execFile)
// Fixture tetap (disalin dari tests/sticker.test.js): WebP 512x512 hasil
// ffmpeg dan PNG 1x1; GIF 1x1 transparan.
const WEBP_B64 = 'UklGRj4CAABXRUJQVlA4WAoAAAAQAAAA/wEA/wEAQUxQSBsAAAABBxARERAIJPt7z1BE/zP+85///Oc///nP/wEAVlA4IPwBAABQOgCdASoAAgACPpFIoU0lpCMiIAgAsBIJaW7hd2EbQAnsA99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych6wAAP7/3giqsgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='
const GIF_B64 = 'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='
const sha256hex = buf => crypto.createHash('sha256').update(buf).digest('hex')

async function tmpDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

// Fixture media via ffmpeg asli (seperti tests/sticker.test.js).
async function makeMp4(root, { seconds = 1, audio = false } = {}) {
  const file = path.join(root, `v-${seconds}-${audio ? 'a' : 'n'}-${Date.now()}.mp4`)
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=red:s=64x64:d=${seconds}:r=5`]
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:d=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest')
  else args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an')
  args.push(file)
  await execFileP('ffmpeg', args)
  return fs.readFile(file)
}
async function makeOgg(root, seconds = 2) {
  const file = path.join(root, `a-${seconds}-${Date.now()}.ogg`)
  await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:d=${seconds}`, '-c:a', 'libopus', '-b:a', '48k', file])
  return fs.readFile(file)
}
async function makeJpg(root, w = 80, h = 60) {
  const file = path.join(root, `img-${w}x${h}-${Date.now()}.jpg`)
  await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=${w}x${h}:d=0.1`, '-frames:v', '1', file])
  return fs.readFile(file)
}
async function makeWebp(root, animated, seconds = 2) {
  const file = path.join(root, `${animated ? 'anim' : 'stat'}-${seconds}-${Date.now()}.webp`)
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=red:s=64x64:d=${seconds}:r=5`, '-c:v', 'libwebp', '-pix_fmt', 'yuva420p', '-loop', '0']
  if (!animated) args.push('-frames:v', '1')
  args.push(file)
  await execFileP('ffmpeg', args)
  return fs.readFile(file)
}

// ─── Lapisan 1: sniff + dimensi + validasi input ─────────────────────────

test('lapis-1: sniff mengenali png/jpg/gif/webp/mp4/ogg dan menolak byte acak', async () => {
  assert.deepEqual((await sniffMedia(Buffer.from(PNG_B64, 'base64'))).kind, 'image')
  assert.deepEqual((await sniffMedia(Buffer.from(GIF_B64, 'base64'))).ext, 'gif')
  assert.deepEqual((await sniffMedia(Buffer.from(WEBP_B64, 'base64'))).kind, 'image')
  assert.equal(await sniffMedia(Buffer.from('halo ini bukan media sama sekali, cuma teks biasa.....')), null)
  assert.equal(await sniffMedia(Buffer.alloc(4)), null)
  assert.equal(await sniffMedia(Buffer.from('MZ' + 'x'.repeat(100))), null, 'executable Windows bukan media')
})

test('lapis-1: dimensi header PNG/GIF/JPEG/WebP terbaca tanpa decode', async t => {
  if (!await ffmpegAvailable()) return t.skip('ffmpeg tidak tersedia')
  const root = await tmpDir(t, 'sailox-conv-dim-')
  assert.deepEqual(parseImageDimensions(Buffer.from(PNG_B64, 'base64'), 'png'), { width: 1, height: 1 })
  assert.deepEqual(parseImageDimensions(Buffer.from(GIF_B64, 'base64'), 'gif'), { width: 1, height: 1 })
  assert.deepEqual(parseImageDimensions(await makeJpg(root, 80, 60), 'jpg'), { width: 80, height: 60 })
  assert.deepEqual(parseImageDimensions(Buffer.from(WEBP_B64, 'base64'), 'webp'), { width: 512, height: 512 })
  const anim = await makeWebp(root, true)
  assert.deepEqual(parseImageDimensions(anim, 'webp'), { width: 64, height: 64 })
  assert.equal(parseImageDimensions(Buffer.from(PNG_B64, 'base64'), 'jpg'), null, 'header PNG bukan JPEG')
})

test('lapis-1: validateConvertInput menolak media buruk (tanpa child process)', async t => {
  if (!await ffmpegAvailable()) return t.skip('ffmpeg tidak tersedia')
  const root = await tmpDir(t, 'sailox-conv-val-')
  const png = Buffer.from(PNG_B64, 'base64')
  const mp4 = await makeMp4(root, { seconds: 1 })
  assert.equal((await validateConvertInput({ buffer: png, job: 'sticker-image', kind: 'image' })).kind, 'image')
  assert.equal((await validateConvertInput({ buffer: mp4, job: 'sticker-video', kind: 'video', seconds: 1 })).kind, 'video')
  await assert.rejects(() => validateConvertInput({ buffer: Buffer.from('bukan media........'), job: 'sticker-image', kind: 'image' }), /Format media tidak dikenali/)
  await assert.rejects(() => validateConvertInput({ buffer: png, job: 'sticker-video', kind: 'video' }), /bukan video/)
  await assert.rejects(() => validateConvertInput({ buffer: mp4, job: 'sticker-image', kind: 'image' }), /bukan gambar/)
  await assert.rejects(() => validateConvertInput({ buffer: png, job: 'sticker-image', kind: 'video' }), /tidak cocok dengan yang dideklarasikan/)
  await assert.rejects(() => validateConvertInput({ buffer: Buffer.alloc(6 * 1024 * 1024), job: 'sticker-video', kind: 'video' }), /maksimal 5 MB/)
  await assert.rejects(() => validateConvertInput({ buffer: mp4, job: 'sticker-video', kind: 'video', seconds: 10 }), /di bawah 10 detik/)
  await assert.rejects(() => validateConvertInput({ buffer: mp4, job: 'sa-video-sticker', kind: 'video', seconds: 26 }), /maksimal 25 detik/)
  await assert.rejects(() => validateConvertInput({ buffer: png, job: 'tidak-ada', kind: 'image' }), /Jenis konversi tidak dikenal/)
})

test('lapis-1: parseStickerArgs menolak karakter kontrol di pack/author', () => {
  assert.throws(() => parseStickerArgs('Pack\x01nakal', {}), /karakter kontrol/)
  assert.throws(() => parseStickerArgs('ok | Auth\x7For', {}), /karakter kontrol/)
  assert.deepEqual(parseStickerArgs('Pack Keren | Veo', {}), { packname: 'Pack Keren', author: 'Veo' })
})

// ─── IPC: tipe baru tervalidasi, tipe asing ditolak ───────────────────────

const goodConvert = { requestId: 'a1b2c3d4e5f60718', purpose: 'sticker', job: 'sticker-image', kind: 'image', file: 'conv-in-a1b2c3d4e5f60718.bin', sha256: 'a'.repeat(64), size: 1234, seconds: 0 }
const goodResult = { requestId: 'a1b2c3d4e5f60718', ok: true, file: 'conv-out-a1b2c3d4e5f60718.webp', sha256: 'b'.repeat(64), size: 4321, media: 'sticker', seconds: 0 }

test('ipc: sticker-convert / sticker-result tervalidasi; bentuk rusak ditolak', () => {
  assert.equal(validIPC({ v: 1, type: 'sticker-convert', ...goodConvert }, 'from-worker'), true)
  assert.equal(validIPC({ v: 1, type: 'sticker-result', ...goodResult }, 'to-worker'), true)
  assert.equal(validIPC({ v: 1, type: 'sticker-result', ...goodResult, ok: false, error: 'gagal' }, 'to-worker'), true)
  assert.equal(validIPC({ v: 1, type: 'sticker-convert', ...goodConvert, file: '../../config.js' }, 'from-worker'), false, 'traversal di nama file')
  assert.equal(validIPC({ v: 1, type: 'sticker-convert', ...goodConvert, file: '/etc/passwd' }, 'from-worker'), false)
  assert.equal(validIPC({ v: 1, type: 'sticker-convert', ...goodConvert, sha256: 'xyz' }, 'from-worker'), false)
  assert.equal(validIPC({ v: 1, type: 'sticker-convert', ...goodConvert, size: 11 * 1024 * 1024 }, 'from-worker'), false)
  assert.equal(validIPC({ v: 1, type: 'sticker-convert', ...goodConvert, job: 'hapus-semua' }, 'from-worker'), false)
  assert.equal(validIPC({ v: 1, type: 'sticker-convert', ...goodConvert, requestId: 'pendek' }, 'from-worker'), false)
  assert.equal(validIPC({ v: 1, type: 'sticker-result', ...goodResult, file: 'conv-out-a1b2c3d4e5f60718.exe' }, 'to-worker'), false)
  assert.equal(validIPC({ v: 1, type: 'sticker-result', ...goodResult, size: 3 * 1024 * 1024 }, 'to-worker'), false)
  assert.equal(validIPC({ v: 1, type: 'sticker-result', ...goodResult, media: 'exe' }, 'to-worker'), false)
  assert.equal(validIPC({ v: 1, type: 'sticker-result', ...goodResult, ok: false }, 'to-worker'), false, 'error wajib ada bila ok:false')
  assert.equal(validIPC({ v: 1, type: 'sticker-convert', ...goodConvert }, 'to-worker'), false, 'request tidak boleh dari arah manager')
  assert.equal(validIPC({ v: 1, type: 'sticker-result', ...goodResult }, 'from-worker'), false, 'result tidak boleh dari arah worker')
  assert.equal(validIPC({ v: 1, type: 'eval-plugin', code: 'x' }, 'from-worker'), false, 'tipe asing tetap ditolak')
})

// ─── Lapisan 2: ffprobe rules (unit, tanpa file) ──────────────────────────

test('lapis-2: checkProbe menolak stream tak terduga / durasi absurd', () => {
  const img = { streams: [{ codec_type: 'video', codec_name: 'png', width: 64, height: 64 }], format: { duration: 'N/A' } }
  assert.deepEqual(checkProbe('sticker-image', img).duration, 0)
  assert.throws(() => checkProbe('sticker-image', { streams: [{ codec_type: 'video', codec_name: 'png', width: 64, height: 64 }, { codec_type: 'audio', codec_name: 'aac' }], format: {} }), /terlalu banyak stream/, 'maxStreams=1 menembak duluan sebelum cek audio')
  assert.throws(() => checkProbe('sticker-image', { streams: [{ codec_type: 'audio', codec_name: 'aac' }], format: {} }), /stream audio tidak diizinkan untuk gambar/)
  assert.throws(() => checkProbe('sticker-image', { streams: [{ codec_type: 'video', codec_name: 'h264', width: 64, height: 64 }], format: {} }), /codec video tidak diizinkan/)
  assert.throws(() => checkProbe('sticker-video', { streams: [{ codec_type: 'video', codec_name: 'h264', width: 64, height: 64 }, { codec_type: 'video', codec_name: 'h264', width: 64, height: 64 }], format: { duration: '1.0' } }), /tepat 1 stream video/)
  assert.throws(() => checkProbe('sticker-video', { streams: [{ codec_type: 'video', codec_name: 'h264', width: 64, height: 64 }, { codec_type: 'subtitle', codec_name: 'mov_text' }], format: { duration: '1.0' } }), /stream tidak diizinkan: subtitle/)
  assert.throws(() => checkProbe('sticker-video', { streams: [{ codec_type: 'video', codec_name: 'h264', width: 64, height: 64 }], format: { duration: '11.0' } }), /melewati batas 10/)
  assert.throws(() => checkProbe('sa-video-sticker', { streams: [{ codec_type: 'video', codec_name: 'h264', width: 64, height: 64 }], format: { duration: '26.0' } }), /melewati batas 25/)
  assert.throws(() => checkProbe('sa-audio', { streams: [{ codec_type: 'video', codec_name: 'h264', width: 64, height: 64 }], format: { duration: '1.0' } }), /tidak ada stream audio/)
  assert.throws(() => checkProbe('sa-audio', { streams: [{ codec_type: 'audio', codec_name: 'aac' }], format: { duration: '301.0' } }), /melewati batas 300/)
  assert.throws(() => checkProbe('sticker-image', { streams: [], format: {} }), /tidak berisi stream/)
  assert.throws(() => checkProbe('job-asing', { streams: [], format: {} }), /job tidak dikenal/)
})

// ─── Kuota ───────────────────────────────────────────────────────────────

test('kuota: maks 2 bersamaan + 30/jam per sub-bot; jendela bergeser', () => {
  const w = {}
  assert.equal(admitConvert(w, 1000), null)
  assert.equal(admitConvert(w, 1000), null)
  assert.match(admitConvert(w, 1000), /bersamaan/)
  releaseConvert(w)
  assert.equal(admitConvert(w, 1000), null, 'lepas satu, satu lagi boleh masuk')
  releaseConvert(w); releaseConvert(w)
  const w2 = {}
  for (let i = 0; i < 30; i++) { assert.equal(admitConvert(w2, 1000 + i), null); releaseConvert(w2) }
  assert.match(admitConvert(w2, 1030), /per jam/)
  assert.equal(admitConvert(w2, 1000 + 3600001), null, 'jendela 1 jam bergeser — yang lama gugur')
})

// ─── Klien worker (transport palsu) ───────────────────────────────────────

function useTmpDir(t, dir) {
  const prev = process.env.TMPDIR
  process.env.TMPDIR = dir
  t.after(() => { if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev })
}

// Transport palsu: tulis hasil kalengan ke tmp lalu balas ok.
function cannedTransport(tmpDir, { outBuffer, media = 'sticker', seconds = 0, tamperHash = false } = {}) {
  return async manifest => {
    const outName = `conv-out-${manifest.requestId}.${media === 'sticker' ? 'webp' : 'ogg'}`
    await fs.writeFile(path.join(tmpDir, outName), outBuffer)
    handleConvertResult({ v: 1, type: 'sticker-result', requestId: manifest.requestId, ok: true, file: outName, sha256: tamperHash ? '0'.repeat(64) : sha256hex(outBuffer), size: outBuffer.length, media, seconds })
  }
}

test('klien: requestConvert sukses — manifest terkirim, hasil terverifikasi', async t => {
  const dir = await tmpDir(t, 'sailox-conv-client-')
  useTmpDir(t, dir)
  const webp = Buffer.from(WEBP_B64, 'base64')
  let seen = null
  initConvertClient(async manifest => { seen = manifest; await cannedTransport(dir, { outBuffer: webp })(manifest) })
  const out = await requestConvert({ job: 'sticker-image', purpose: 'sticker', kind: 'image', buffer: Buffer.from(PNG_B64, 'base64'), seconds: 0 })
  assert.ok(out.buffer.equals(webp), 'buffer hasil = webp kalengan')
  assert.equal(out.media, 'sticker')
  assert.match(seen.file, /^conv-in-[0-9a-f]{16}\.bin$/)
  assert.equal(seen.sha256, sha256hex(Buffer.from(PNG_B64, 'base64')))
  assert.equal(seen.size, Buffer.from(PNG_B64, 'base64').length)
  assert.deepEqual(await fs.readdir(dir), [], 'tmp bersih setelah selesai')
})

test('klien: validasi lapis-1 menolak SEBELUM transport dipanggil', async t => {
  const dir = await tmpDir(t, 'sailox-conv-client2-')
  useTmpDir(t, dir)
  let called = 0
  initConvertClient(async () => { called++ })
  await assert.rejects(() => requestConvert({ job: 'sticker-image', purpose: 'sticker', kind: 'image', buffer: Buffer.from('bukan media........') }), /Format media tidak dikenali/)
  await assert.rejects(() => requestConvert({ job: 'sticker-video', purpose: 'sticker', kind: 'video', buffer: Buffer.from(PNG_B64, 'base64') }), /bukan video/)
  assert.equal(called, 0, 'tidak ada IPC keluar untuk media buruk')
})

test('klien: hash balasan tidak cocok / magic salah ditolak', async t => {
  const dir = await tmpDir(t, 'sailox-conv-client3-')
  useTmpDir(t, dir)
  const webp = Buffer.from(WEBP_B64, 'base64')
  initConvertClient(cannedTransport(dir, { outBuffer: webp, tamperHash: true }))
  await assert.rejects(() => requestConvert({ job: 'sticker-image', purpose: 'sticker', kind: 'image', buffer: Buffer.from(PNG_B64, 'base64') }), /tidak cocok \(hash\)/)
  initConvertClient(cannedTransport(dir, { outBuffer: Buffer.from(PNG_B64, 'base64') }))
  await assert.rejects(() => requestConvert({ job: 'sticker-image', purpose: 'sticker', kind: 'image', buffer: Buffer.from(PNG_B64, 'base64') }), /bukan stiker WebP/)
  assert.equal(handleConvertResult({ requestId: 'tidakada00000000' }), false, 'requestId asing diabaikan')
})

test('klien: timeout bila manager tidak membalas', async t => {
  const dir = await tmpDir(t, 'sailox-conv-client4-')
  useTmpDir(t, dir)
  initConvertClient(async () => { /* diam */ })
  await assert.rejects(() => requestConvert({ job: 'sticker-image', purpose: 'sticker', kind: 'image', buffer: Buffer.from(PNG_B64, 'base64'), timeoutMs: 50 }), /kehabisan waktu/)
})

test('klien: stampStickerMeta hanya menimpa EXIF, packId dipertahankan', () => {
  const webp = Buffer.from(WEBP_B64, 'base64')
  const stamped = stampStickerMeta(webp, { packname: 'Pack Keren', author: 'Veo', emojis: [''] })
  const meta = extractStickerMeta(stamped)
  assert.equal(meta['sticker-pack-name'], 'Pack Keren')
  assert.equal(meta['sticker-pack-publisher'], 'Veo')
  const id = meta['sticker-pack-id']
  const restamped = stampStickerMeta(stamped, { packname: 'Lain', author: 'Veo', emojis: ['🔊'] })
  assert.equal(extractStickerMeta(restamped)['sticker-pack-id'], id, 'packId sama sepanjang rantai')
  assert.equal(extractStickerMeta(restamped)['sticker-pack-name'], 'Lain')
  assert.deepEqual(extractStickerMeta(restamped).emojis, ['🔊'])
  assert.equal(extractStickerMeta(webp), null, 'fixture tanpa EXIF')
})

// ─── Manager end-to-end (ffmpeg asli, stub worker) ────────────────────────

function managerConfig() { return { enabled: true, maxBots: 2, maxPerUser: 1, pairingTimeoutSec: 120, heapMB: 256, spawnStaggerSec: 0, allowCustomPlugins: false, maxPlugins: 30, maxPluginKB: 64, maxDiskMB: 100, outbound: { perChatMs: 1200, perSecond: 3 }, allowedPackages: [], logRelay: 'masked' } }

async function setupManager(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-conv-mgr-'))
  await fs.mkdir(path.join(root, 'lib/subbot/templates/plugins'), { recursive: true })
  await fs.writeFile(path.join(root, 'lib/subbot/templates/plugins/ping.js'), 'export default async () => {}')
  const db = await new Database({ dir: path.join(root, 'databases') }).load()
  const conn = fakeConn({ db })
  conn.identity.learn({ lid: LID, jid: PN })
  db.ensure('settings', BOTLID).jadibot = true
  global.prefix = '.'; global.timezone = 'Asia/Jakarta'; global.countryCode = '62'; global.defaultLimit = 100
  const spawned = [], sent = [], notifications = []
  const timers = { setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout: () => ({ unref() {} }), clearTimeout() {} }
  function spawn() { const child = new EventEmitter(); Object.assign(child, { connected: true, stdout: new EventEmitter(), stderr: new EventEmitter(), send(m, cb) { sent.push(m); cb?.(); if (m.type === 'stop') setImmediate(() => { child.exitCode = 0; child.connected = false; child.emit('exit', 0) }) }, kill() { child.connected = false; child.exitCode = 1; setImmediate(() => child.emit('exit', 1)) } }); spawned.push(child); return { child, permission: true, allowCustomPlugins: false } }
  const manager = new SubBotManager({ root, db, getConn: () => conn, config: managerConfig(), timers, spawn, notify: async (r, text) => notifications.push(text) })
  // Urutan after-hook penting (FIFO): stopAll dulu — registry.set menulis
  // ke databases/ — baru hapus root.
  t.after(async () => { await manager.stopAll(); await conn.store.close() })
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const id = await manager.create('6281234567890', { lid: LID, jid: PN, name: 'User' })
  spawned[0].emit('message', { v: 1, type: 'ready', pid: 42 })
  for (let i = 0; i < 10; i++) await tick()
  await manager.workers.get(id).handling.run('ipc', async () => {})
  spawned[0].emit('message', { v: 1, type: 'status', state: 'open', me: { id: PN, lid: LID } })
  await manager.workers.get(id).handling.run('ipc', async () => {})
  const sandbox = path.join(root, 'bots', id)
  const waitResult = async (requestId, timeoutMs = 60000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const found = sent.find(m => m.type === 'sticker-result' && m.requestId === requestId)
      if (found) return found
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error('tidak ada sticker-result untuk ' + requestId)
  }
  // Tulis input ke tmp sandbox lalu kirim manifest seperti worker asli.
  const sendConvert = async ({ buffer, job, purpose = 'sticker', kind, seconds = 0, sha256, file } = {}) => {
    const requestId = crypto.randomBytes(8).toString('hex')
    const name = file ?? `conv-in-${requestId}.bin`
    await fs.writeFile(path.join(sandbox, 'tmp', name), buffer)
    const manifest = { v: 1, type: 'sticker-convert', requestId, purpose, job, kind, file: name, sha256: sha256 ?? sha256hex(buffer), size: buffer.length, seconds }
    spawned[0].emit('message', manifest)
    return waitResult(requestId)
  }
  return { root, db, conn, manager, id, sandbox, spawned, sent, waitResult, sendConvert }
}

test('e2e manager: PNG -> stiker webp valid lewat channel (ffmpeg asli)', async t => {
  if (!await ffmpegAvailable()) return t.skip('ffmpeg tidak tersedia')
  const s = await setupManager(t)
  const before = (await fs.readdir(os.tmpdir())).filter(x => x.startsWith('sailox-conv-')).length
  const res = await s.sendConvert({ buffer: Buffer.from(PNG_B64, 'base64'), job: 'sticker-image', kind: 'image' })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.media, 'sticker')
  const out = await fs.readFile(path.join(s.sandbox, 'tmp', res.file))
  assert.equal(out.toString('ascii', 0, 4), 'RIFF')
  assert.equal(out.toString('ascii', 8, 12), 'WEBP')
  assert.equal(sha256hex(out), res.sha256)
  assert.equal(extractStickerMeta(out)['sticker-pack-name'], '', 'bot utama tidak menempel pack/author — itu tugas sub-bot')
  const after = (await fs.readdir(os.tmpdir())).filter(x => x.startsWith('sailox-conv-')).length
  assert.equal(after, before, 'temp dir terisolasi dibersihkan')
})

test('e2e manager: video -> stiker animasi; video+audio -> .sa (webp + ogg)', async t => {
  if (!await ffmpegAvailable()) return t.skip('ffmpeg tidak tersedia')
  const s = await setupManager(t)
  const root = await tmpDir(t, 'sailox-conv-e2e-')
  const mp4 = await makeMp4(root, { seconds: 1, audio: true })
  const resVid = await s.sendConvert({ buffer: mp4, job: 'sticker-video', kind: 'video', seconds: 1 })
  assert.equal(resVid.ok, true, JSON.stringify(resVid))
  const webp = await fs.readFile(path.join(s.sandbox, 'tmp', resVid.file))
  assert.equal(webp.toString('ascii', 8, 12), 'WEBP')
  const resSa = await s.sendConvert({ buffer: mp4, job: 'sa-video-sticker', kind: 'video', seconds: 1, purpose: 'sound-sticker' })
  assert.equal(resSa.ok, true, JSON.stringify(resSa))
  const saWebp = await fs.readFile(path.join(s.sandbox, 'tmp', resSa.file))
  assert.ok(saWebp.length <= 880 * 1024, 'stiker video .sa muat 880 KB')
  assert.deepEqual(extractStickerMeta(saWebp).emojis, ['🔊'], 'emoji sound sticker ikut dari bot utama')
  const ogg = await makeOgg(root, 2)
  const resAudio = await s.sendConvert({ buffer: ogg, job: 'sa-audio', kind: 'audio', seconds: 2, purpose: 'sound-sticker' })
  assert.equal(resAudio.ok, true, JSON.stringify(resAudio))
  assert.equal(resAudio.media, 'audio')
  const oggOut = await fs.readFile(path.join(s.sandbox, 'tmp', resAudio.file))
  assert.equal(oggOut.toString('ascii', 0, 4), 'OggS')
  assert.ok(resAudio.seconds > 0, 'durasi audio terbaca')
})

test('e2e manager: file yang dirusak ditolak — hash, magic, traversal (anomali), ffprobe', async t => {
  if (!await ffmpegAvailable()) return t.skip('ffmpeg tidak tersedia')
  const s = await setupManager(t)
  const root = await tmpDir(t, 'sailox-conv-tamper-')
  const png = Buffer.from(PNG_B64, 'base64')
  const mp4 = await makeMp4(root, { seconds: 1 })
  // (b) hash tidak cocok: isi file diganti setelah manifest dibuat.
  const resHash = await s.sendConvert({ buffer: png, job: 'sticker-image', kind: 'image', sha256: sha256hex(mp4) })
  assert.equal(resHash.ok, false)
  assert.match(resHash.error, /Hash file tidak cocok/)
  // (c) magic tidak cocok: deklarasi gambar, isi video.
  const resMagic = await s.sendConvert({ buffer: mp4, job: 'sticker-image', kind: 'image' })
  assert.equal(resMagic.ok, false)
  assert.match(resMagic.error, /tidak cocok dengan yang dideklarasikan/)
  // (a) traversal: manifest gagal validIPC -> TIDAK dibalas (anomali IPC,
  // pola yang sama untuk semua tipe pesan — bukan balasan ok:false).
  // Cek lapis-2-nya (INPUT_FILE_RE) ada di tes 'traversal ditolak' di bawah.
  const w = s.manager.workers.get(s.id)
  const anomaliesBefore = w.anomalies
  const resultsBefore = s.sent.filter(m => m.type === 'sticker-result').length
  s.spawned[0].emit('message', { v: 1, type: 'sticker-convert', requestId: crypto.randomBytes(8).toString('hex'), purpose: 'sticker', job: 'sticker-image', kind: 'image', file: '../../config.js', sha256: sha256hex(png), size: png.length, seconds: 0 })
  await s.manager.workers.get(s.id).handling.run('ipc', async () => {})
  assert.equal(w.anomalies, anomaliesBefore + 1, 'manifest jahat dihitung anomali')
  assert.equal(s.sent.filter(m => m.type === 'sticker-result').length, resultsBefore, 'tidak ada balasan untuk manifest yang gagal validasi')
  // (d) ffprobe gagal: header MP4 utuh tapi badan terpotong (tanpa moov).
  const truncated = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)])
  const resProbe = await s.sendConvert({ buffer: truncated, job: 'sticker-video', kind: 'video', seconds: 1 })
  assert.equal(resProbe.ok, false)
  assert.match(resProbe.error, /Konversi gagal|tidak bisa dibaca/)
})

test('lapis-2: traversal ditolak layanan walau validIPC dilewati (panggilan langsung)', async t => {
  if (!await ffmpegAvailable()) return t.skip('ffmpeg tidak tersedia')
  const s = await setupManager(t)
  const png = Buffer.from(PNG_B64, 'base64')
  const sent2 = []
  const fakeChild = { connected: true, send(m, cb) { sent2.push(m); cb?.() } }
  const requestId = crypto.randomBytes(8).toString('hex')
  await fs.writeFile(path.join(s.sandbox, 'tmp', `conv-in-${requestId}.bin`), png)
  await handleStickerConvert(s.manager, s.id, { child: fakeChild }, { requestId, purpose: 'sticker', job: 'sticker-image', kind: 'image', file: '../../config.js', sha256: sha256hex(png), size: png.length, seconds: 0 })
  assert.equal(sent2.length, 1, 'tepat satu balasan')
  assert.equal(sent2[0].ok, false)
  assert.match(sent2[0].error, /Nama file konversi tidak valid/)
  assert.equal(await fs.readFile(path.join(s.root, 'config.js')).catch(() => null), null, 'tidak ada file yang ditulis di luar sandbox')
})

test('e2e manager: symlink di tmp sandbox ditolak (path confinement)', async t => {
  if (!await ffmpegAvailable()) return t.skip('ffmpeg tidak tersedia')
  const s = await setupManager(t)
  const root = await tmpDir(t, 'sailox-conv-sym-')
  const png = Buffer.from(PNG_B64, 'base64')
  const outside = path.join(root, 'outside.bin')
  await fs.writeFile(outside, png)
  const requestId = crypto.randomBytes(8).toString('hex')
  const name = `conv-in-${requestId}.bin`
  await fs.symlink(outside, path.join(s.sandbox, 'tmp', name))
  s.spawned[0].emit('message', { v: 1, type: 'sticker-convert', requestId, purpose: 'sticker', job: 'sticker-image', kind: 'image', file: name, sha256: sha256hex(png), size: png.length, seconds: 0 })
  const res = await s.waitResult(requestId)
  assert.equal(res.ok, false, 'symlink keluar tmp tidak boleh diikuti')
})

test('e2e manager: kuota bersamaan ditegakkan di cabang IPC', async t => {
  if (!await ffmpegAvailable()) return t.skip('ffmpeg tidak tersedia')
  const s = await setupManager(t)
  const w = s.manager.workers.get(s.id)
  assert.equal(admitConvert(w), null)
  assert.equal(admitConvert(w), null)
  const png = Buffer.from(PNG_B64, 'base64')
  const res = await s.sendConvert({ buffer: png, job: 'sticker-image', kind: 'image' })
  assert.equal(res.ok, false)
  assert.match(res.error, /Terlalu banyak konversi bersamaan/)
  releaseConvert(w); releaseConvert(w)
  const res2 = await s.sendConvert({ buffer: png, job: 'sticker-image', kind: 'image' })
  assert.equal(res2.ok, true, 'setelah lepas, konversi jalan lagi')
})

// ─── Plugin .s/.sa di konteks sub-bot (transport palsu) ───────────────────

function subConn() {
  const calls = []
  return {
    role: 'sub', calls,
    async sendMessage(jid, content, options) { calls.push({ jid, content, options }); return { key: { id: 'x' } } },
    async relayMessage(jid, payload, options) { calls.push({ jid, relay: payload, options }); return { key: { id: 'x' } } },
    async waUploadToServer() { throw new Error('upload dimatikan di tes') },
  }
}

function fakeM({ conn, mtype, mime, buffer, seconds = 0, fileLength = 0 }) {
  return {
    key: { remoteJid: '6281234567890@s.whatsapp.net', id: 'msg1', fromMe: false },
    chat: '6281234567890@s.whatsapp.net',
    sender: '6281234567890@s.whatsapp.net',
    conn,
    mtype,
    mediaMessage: { [mtype]: { mimetype: mime } },
    msg: { mimetype: mime, seconds, fileLength, download: async () => buffer },
    download: async () => buffer,
    quoted: null,
  }
}

// Transport palsu yang menjawab sesuai job (webp untuk stiker, ogg untuk audio).
function pluginTransport(tmpDir, { webp, ogg }) {
  return async manifest => {
    const isAudio = manifest.job === 'sa-audio'
    const out = isAudio ? ogg : webp
    const outName = `conv-out-${manifest.requestId}.${isAudio ? 'ogg' : 'webp'}`
    await fs.writeFile(path.join(tmpDir, outName), out)
    handleConvertResult({ v: 1, type: 'sticker-result', requestId: manifest.requestId, ok: true, file: outName, sha256: sha256hex(out), size: out.length, media: isAudio ? 'audio' : 'sticker', seconds: isAudio ? 2 : 0 })
  }
}

test('plugin .s sub-bot: tanpa pack/author -> EXIF dibiarkan; dengan input -> ditempel', async t => {
  const dir = await tmpDir(t, 'sailox-conv-plug-s-')
  useTmpDir(t, dir)
  const webp = Buffer.from(WEBP_B64, 'base64')
  const png = Buffer.from(PNG_B64, 'base64')
  initConvertClient(pluginTransport(dir, { webp, ogg: Buffer.alloc(0) }))
  const conn = subConn()
  await stickerHandler(fakeM({ conn, mtype: 'imageMessage', mime: 'image/png', buffer: png }), { conn, text: '', __dirname: '/tmp/x' })
  const sentSticker = conn.calls.find(c => c.content?.sticker)?.content.sticker
  assert.ok(sentSticker, 'stiker terkirim')
  assert.equal(extractStickerMeta(sentSticker), null, 'tanpa input pack/author, EXIF dari bot utama dibiarkan (kosong)')
  await stickerHandler(fakeM({ conn, mtype: 'imageMessage', mime: 'image/png', buffer: png }), { conn, text: 'MyPack | Me', __dirname: '/tmp/x' })
  const sent2 = conn.calls.filter(c => c.content?.sticker).at(-1).content.sticker
  const meta = extractStickerMeta(sent2)
  assert.equal(meta['sticker-pack-name'], 'MyPack')
  assert.equal(meta['sticker-pack-publisher'], 'Me')
})

test('plugin .sa sub-bot: foto -> sesi; VN -> stiker + audio (fallback, tanpa upload)', async t => {
  if (!await ffmpegAvailable()) return t.skip('ffmpeg tidak tersedia')
  const dir = await tmpDir(t, 'sailox-conv-plug-sa-')
  useTmpDir(t, dir)
  const root = await tmpDir(t, 'sailox-conv-plug-sa2-')
  const webp = Buffer.from(WEBP_B64, 'base64')
  const ogg = await makeOgg(root, 2)
  const png = Buffer.from(PNG_B64, 'base64')
  initConvertClient(pluginTransport(dir, { webp, ogg }))
  const conn = subConn()
  // Tanpa sesi dulu: VN ditolak dengan pesan yang jelas.
  await assert.rejects(() => saHandler(fakeM({ conn, mtype: 'audioMessage', mime: 'audio/ogg; codecs=opus', buffer: ogg, seconds: 2 }), { conn, text: '', __dirname: '/tmp/x' }), /Reply foto dengan \.sa terlebih dahulu/)
  // Foto -> sesi tersimpan (balasan 'Foto diterima').
  await saHandler(fakeM({ conn, mtype: 'imageMessage', mime: 'image/png', buffer: png }), { conn, text: '', __dirname: '/tmp/x' })
  assert.ok(conn.calls.some(c => c.content?.text?.startsWith('Foto diterima!')), 'sesi foto dibuat')
  // VN -> deliver (upload dimatikan -> fallback stiker + audio terpisah).
  await saHandler(fakeM({ conn, mtype: 'audioMessage', mime: 'audio/ogg; codecs=opus', buffer: ogg, seconds: 2 }), { conn, text: '', __dirname: '/tmp/x' })
  const stickerSend = conn.calls.find(c => c.content?.sticker)
  const audioSend = conn.calls.find(c => c.content?.audio)
  assert.ok(stickerSend, 'stiker terkirim (fallback)')
  assert.ok(audioSend, 'audio terkirim (fallback)')
  assert.equal(audioSend.content.audio.toString('ascii', 0, 4), 'OggS')
  assert.equal(audioSend.content.mimetype, 'audio/ogg; codecs=opus')
})

test('plugin .sa sub-bot: video -> stiker animasi + audio; pack ditempel bila diberi', async t => {
  if (!await ffmpegAvailable()) return t.skip('ffmpeg tidak tersedia')
  const dir = await tmpDir(t, 'sailox-conv-plug-sav-')
  useTmpDir(t, dir)
  const root = await tmpDir(t, 'sailox-conv-plug-sav2-')
  const webp = Buffer.from(WEBP_B64, 'base64')
  const ogg = await makeOgg(root, 2)
  const mp4 = await makeMp4(root, { seconds: 1, audio: true })
  initConvertClient(pluginTransport(dir, { webp, ogg }))
  const conn = subConn()
  await saHandler(fakeM({ conn, mtype: 'videoMessage', mime: 'video/mp4', buffer: mp4, seconds: 1 }), { conn, text: 'PackQ | AuthQ', __dirname: '/tmp/x' })
  const stickerSend = conn.calls.find(c => c.content?.sticker)
  assert.ok(stickerSend, 'stiker video terkirim (fallback)')
  const meta = extractStickerMeta(stickerSend.content.sticker)
  assert.equal(meta['sticker-pack-name'], 'PackQ')
  assert.equal(meta['sticker-pack-publisher'], 'AuthQ')
  assert.deepEqual(meta.emojis, ['🔊'], 'emoji sound sticker dipertahankan saat re-stamp')
  assert.ok(conn.calls.some(c => c.content?.audio), 'audio video terkirim (fallback)')
})
