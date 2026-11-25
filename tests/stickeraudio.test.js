import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { proto } from '@whiskeysockets/baileys'
import handler, { patchProto, MAX_DURATION, SESSION_MS } from '../plugins/sticker/stickeraudio.js'
import { buildStickerExif, extractStickerMeta, addExifToWebp } from '../lib/media/sticker.js'

// Fixture tetap (disalin dari tests/sticker.test.js): WebP 512x512 hasil
// ffmpeg dan PNG 1x1.
const WEBP_B64 = 'UklGRj4CAABXRUJQVlA4WAoAAAAQAAAA/wEA/wEAQUxQSBsAAAABBxARERAIJPt7z1BE/zP+85///Oc///nP/wEAVlA4IPwBAABQOgCdASoAAgACPpFIoU0lpCMiIAgAsBIJaW7hd2EbQAnsA99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych6wAAP7/3giqsgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='

test('command: .sa + alias Yue, case-insensitive, tanpa false positive', () => {
  for (const cmd of ['sa', 'SA', 'Sa', 'audiosticker', 'AUDIOSTICKER', 'asticker', 'astiker', 'saudio', 'stickeraudio']) {
    assert.equal(handler.command.test(cmd), true, cmd)
  }
  for (const cmd of ['s', 'sax', 'asa', 'stickeraudio2', 'sa2', '', 'sticker']) {
    assert.equal(handler.command.test(cmd), false, cmd)
  }
  assert.equal(handler.premium, undefined, 'terbuka untuk semua (gratis dulu, keputusan Veo 2026-11-25)')
  assert.equal(handler.limit, true, '.sa masuk aturan limit (biaya 1; langkah foto/batal dibebaskan lewat m.limit = 0)')
  assert.deepEqual(handler.tags, ['sticker'])
  assert.ok(handler.help.length >= 1)
})

test('batas: video/audio maks 25 dtk, sesi 60 dtk', () => {
  assert.equal(MAX_DURATION, 25)
  assert.equal(SESSION_MS, 60000)
})

test('EXIF stiker: emoji 🔊 tertulis, bawaan helper tetap [\'\']', () => {
  // buildStickerExif mengembalikan chunk EXIF mentah (header TIFF 22
  // byte + JSON), bukan file WebP — baca JSON-nya langsung.
  const readMeta = buf => JSON.parse(buf.subarray(22).toString('utf8'))
  const withSound = buildStickerExif({ packname: 'P', author: 'A', packId: 'id-1', emojis: ['🔊'] })
  assert.deepEqual(readMeta(withSound).emojis, ['🔊'])
  const def = buildStickerExif({ packname: 'P', author: 'A', packId: 'id-1' })
  assert.deepEqual(readMeta(def).emojis, [''])
})

test('addExifToWebp: emoji 🔊 bertahan sampai dibaca kembali', async () => {
  const webp = Buffer.from(WEBP_B64, 'base64')
  const out = addExifToWebp(webp, { packname: 'P', author: 'A', packId: 'id-2', emojis: ['🔊'] })
  assert.deepEqual(extractStickerMeta(out).emojis, ['🔊'])
})

// ── Tes wire format (inti fitur) ─────────────────────────────────────────
// Encode pesan yang sama seperti sendAudioSticker (payload relayMessage)
// lewat proto Baileys ASLI yang dipakai Sailox, lalu baca kembali
// byte-per-byte: membuktikan patchProto menulis field 26 (audio di dalam
// StickerMessage) dan field 134 (audioStickerMessage di Message).
// Encode stock Baileys TIDAK kenal kedua field itu, jadi decode biasa
// membuangnya — karena itu tes ini membaca tag protobuf mentah, bukan
// hasil decode.
//
// CATATAN PENTING soal bentuk wire-nya (terverifikasi dari kode generate
// WAProto/index.js baris 36186, sama persis di fork PontaLabs): encode
// stock mensyaratkan `Object.hasOwnProperty.call(m, "stickerMessage")`,
// jadi stickerMessage yang dititipkan lewat `__proto__: prepared` TIDAK
// tertulis di top-level — ia hanya hidup di dalam bungkus field 134.
// Itu memang bentuk yang dimaksud plugin Yue: top-level hanya berisi
// messageContextInfo + audioStickerMessage; stiker + audio seluruhnya
// ada di dalam FutureProofMessage.
function readVarint(buf, off) {
  let value = 0
  let shift = 0
  let i = off
  for (;;) {
    const b = buf[i++]
    value |= (b & 0x7f) << shift
    if (!(b & 0x80)) break
    shift += 7
  }
  return { value, next: i }
}

// Kembalikan semua field: [{ field, wire, data? (wire 2), value? (wire 0) }]
function walkFields(buf) {
  const out = []
  let off = 0
  while (off < buf.length) {
    const tag = readVarint(buf, off)
    const field = tag.value >>> 3
    const wire = tag.value & 7
    off = tag.next
    if (wire === 2) {
      const len = readVarint(buf, off)
      off = len.next
      out.push({ field, wire, data: Buffer.from(buf.subarray(off, off + len.value)) })
      off += len.value
    } else if (wire === 0) {
      const v = readVarint(buf, off)
      out.push({ field, wire, value: v.value })
      off = v.next
    } else if (wire === 5) { out.push({ field, wire }); off += 4 } else if (wire === 1) { out.push({ field, wire }); off += 8 } else { throw new Error('wire type tidak dikenal: ' + wire) }
  }
  return out
}

const fill = (n, v) => { const b = Buffer.alloc(n); b.fill(v); return new Uint8Array(b) }
const stickerFixture = {
  url: 'https://mmg.whatsapp.net/d/f/AbCdEfGhIjKlMnOp',
  fileSha256: fill(32, 0x11),
  fileEncSha256: fill(32, 0x22),
  mediaKey: fill(32, 0x33),
  mimetype: 'image/webp',
  height: 512,
  width: 512,
  directPath: 'abc/def.webp',
  fileLength: 12345,
  mediaKeyTimestamp: 1700000000,
  isAnimated: false,
  pngThumbnail: new Uint8Array([1, 2, 3]),
  contextInfo: {},
  stickerSentTs: 1700000000,
  mediaKeyDomain: 1,
}
const audioFixture = {
  url: 'https://mmg.whatsapp.net/d/f/AuDiO1234567890',
  mimetype: 'audio/ogg; codecs=opus',
  fileSha256: fill(32, 0x44),
  fileLength: 9999,
  seconds: 5,
  ptt: true,
  mediaKey: fill(32, 0x55),
  fileEncSha256: fill(32, 0x66),
  directPath: 'abc/audio.ogg',
  mediaKeyTimestamp: 1700000000,
  waveform: fill(64, 0x2a),
}

function buildPayload() {
  const prepared = { stickerMessage: { ...stickerFixture, audioMessage: audioFixture } }
  return {
    prepared,
    payload: {
      __proto__: prepared,
      audioStickerMessage: { message: prepared },
      messageContextInfo: { messageSecret: crypto.randomBytes(32) },
    },
  }
}

// Simpan encode asli SEBELUM patch — baseline harus memakai fungsi asli
// apa pun urutan tesnya (patch sekali per proses, tidak bisa dilepas).
const rawMessageEncode = proto.Message.encode

test('wire: tanpa patch, field 26 & 134 TIDAK tertulis', () => {
  const { payload } = buildPayload()
  const bytes = Buffer.from(rawMessageEncode(payload).finish())
  const top = walkFields(bytes)
  assert.equal(top.some(f => f.field === 134), false, 'audioStickerMessage tidak boleh ada tanpa patch')
  assert.equal(top.some(f => f.field === 26), false, 'stickerMessage tidak di top-level (hanya via __proto__)')
})

test('wire: dengan patchProto, field 134 tertulis; stiker+audio di dalamnya', () => {
  patchProto()
  const { prepared, payload } = buildPayload()
  const bytes = Buffer.from(proto.Message.encode(payload).finish())
  assert.ok(bytes.length > Buffer.from(rawMessageEncode(payload).finish()).length, 'encode ter-patch lebih panjang (field tambahan tertulis)')

  const top = walkFields(bytes)
  assert.equal(top.some(f => f.field === 26), false, 'stickerMessage tetap tidak di top-level')
  const asm = top.find(f => f.field === 134)
  assert.ok(asm, 'audioStickerMessage (field 134) tertulis di Message')

  // FutureProofMessage: field 1 = message (pesan utuh yang dibungkus).
  const fpFields = walkFields(asm.data)
  const innerMsg = fpFields.find(f => f.field === 1)
  assert.ok(innerMsg, 'FutureProofMessage membawa message')
  const innerFields = walkFields(innerMsg.data)
  const innerSticker = innerFields.find(f => f.field === 26)
  assert.ok(innerSticker, 'stickerMessage ada di dalam bungkus (field 26 Message)')
  const stickerFields = walkFields(innerSticker.data)
  const audioField = stickerFields.find(f => f.field === 26)
  assert.ok(audioField, 'audioMessage (field 26) tertulis di dalam StickerMessage')
  const audio = proto.Message.AudioMessage.decode(audioField.data)
  assert.equal(audio.mimetype, 'audio/ogg; codecs=opus')
  assert.equal(audio.seconds, 5)
  assert.equal(audio.ptt, true)

  // Decode stock juga bisa membaca stiker di dalam bungkus (field yang
  // dikenal) — membuktikan bungkusnya valid, bukan sekadar byte mentah.
  const inner = proto.Message.FutureProofMessage.decode(asm.data)
  assert.equal(inner.message.stickerMessage.url, stickerFixture.url)

  // Patch memulihkan objek pemanggil setelah encode.
  assert.equal(prepared.stickerMessage.audioMessage, audioFixture)
  assert.equal(payload.audioStickerMessage.message, prepared)
})

// ── Tes alur handler dengan soket palsu ───────────────────────────────────
function fakeConn() {
  const calls = []
  return {
    calls,
    sendMessage: async (...args) => { calls.push(args); return { key: { id: 'fake' } } },
  }
}

function wavSilence(seconds = 1, rate = 8000) {
  const samples = rate * seconds
  const data = Buffer.alloc(samples * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8)
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34)
  head.write('data', 36); head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

test('handler: .sa batal tanpa sesi -> lempar pesan yang benar', async () => {
  const conn = fakeConn()
  const m = { chat: '6281@s.whatsapp.net', sender: '6281@s.whatsapp.net', conn, key: { remoteJid: '6281@s.whatsapp.net', id: 'x1', fromMe: false } }
  await assert.rejects(handler(m, { conn, text: 'batal', __dirname: path.resolve('plugins', 'sticker') }), e => e === 'Tidak ada sesi yang aktif.')
  assert.equal(conn.calls.length, 0)
})

test('handler: reply VN tanpa sesi foto -> lempar, tanpa kirim apa pun', async () => {
  const conn = fakeConn()
  const quoted = {
    mtype: 'audioMessage',
    mediaMessage: { mimetype: 'audio/ogg; codecs=opus' },
    mediaType: 'audio',
    msg: { mimetype: 'audio/ogg; codecs=opus' },
    download: async () => wavSilence(1),
  }
  const m = { chat: '6282@s.whatsapp.net', sender: '6282@s.whatsapp.net', quoted, conn, key: { remoteJid: '6282@s.whatsapp.net', id: 'x2', fromMe: false } }
  await assert.rejects(
    handler(m, { conn, text: '', __dirname: path.resolve('plugins', 'sticker') }),
    e => e === 'Reply foto dengan .sa terlebih dahulu, lalu reply voice note atau audio dengan .sa.'
  )
  assert.equal(conn.calls.length, 0)
})

test('handler: .sa batal tidak makan limit (m.limit = 0)', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-sa-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dir = path.join(root, 'plugins', 'sticker')
  await fs.mkdir(dir, { recursive: true })
  const conn = fakeConn()
  const chat = '6284@s.whatsapp.net'
  const sender = '6284@s.whatsapp.net'
  const key = { remoteJid: chat, id: 'x6', fromMe: false }
  const imgQuoted = {
    mtype: 'imageMessage',
    mediaMessage: { mimetype: 'image/png' },
    mediaType: 'image',
    msg: { mimetype: 'image/png' },
    download: async () => Buffer.from(PNG_B64, 'base64'),
  }
  const m1 = { chat, sender, quoted: imgQuoted, conn, key }
  await handler(m1, { conn, text: '', __dirname: dir })
  assert.equal(m1.limit, 0, 'foto: m.limit = 0')
  const m2 = { chat, sender, conn, key: { ...key, id: 'x7' } }
  await handler(m2, { conn, text: 'batal', __dirname: dir })
  assert.equal(m2.limit, 0, 'batal: m.limit = 0')
  assert.ok(conn.calls.some(([, c]) => typeof c?.text === 'string' && c.text.startsWith('Sesi Audio Sticker berhasil dibatalkan')), 'balasan batal terkirim')
})

test('handler: foto -> sesi tersimpan, VN -> fallback stiker+audio (tanpa upload)', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-sa-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dir = path.join(root, 'plugins', 'sticker')
  await fs.mkdir(dir, { recursive: true })
  const conn = fakeConn()
  const chat = '6283@s.whatsapp.net'
  const sender = '6283@s.whatsapp.net'
  const key = { remoteJid: chat, id: 'x3', fromMe: false }

  const imgQuoted = {
    mtype: 'imageMessage',
    mediaMessage: { mimetype: 'image/png' },
    mediaType: 'image',
    msg: { mimetype: 'image/png' },
    download: async () => Buffer.from(PNG_B64, 'base64'),
  }
  const m1 = { chat, sender, quoted: imgQuoted, conn, key }
  await handler(m1, { conn, text: '', __dirname: dir })
  assert.equal(m1.limit, 0, 'langkah foto hanya membuat sesi — tidak makan limit')
  const gotPhoto = conn.calls.find(([jid, content]) => jid === chat && typeof content?.text === 'string' && content.text.startsWith('Foto diterima!'))
  assert.ok(gotPhoto, 'balasan "Foto diterima!" terkirim')

  const audioQuoted = {
    mtype: 'audioMessage',
    mediaMessage: { mimetype: 'audio/wav' },
    mediaType: 'audio',
    msg: { mimetype: 'audio/wav' },
    download: async () => wavSilence(1),
  }
  const m2 = { chat, sender, quoted: audioQuoted, conn, key: { ...key, id: 'x4' } }
  await handler(m2, { conn, text: '', __dirname: dir })
  assert.equal(m2.limit, undefined, 'langkah VN adalah pengiriman — biaya penuh (1)')
  // Soket palsu tidak punya waUploadToServer -> buildAudioMessage gagal
  // -> deliver jatuh ke fallback: stiker lalu audio, masing-masing satu
  // kiriman. (Jalur relay asli hanya bisa dibuktikan tes live.)
  const stickerSends = conn.calls.filter(([, c]) => Buffer.isBuffer(c?.sticker))
  const audioSends = conn.calls.filter(([, c]) => Buffer.isBuffer(c?.audio) && c.ptt === true)
  assert.ok(stickerSends.length >= 1, 'fallback mengirim stiker')
  assert.ok(audioSends.length >= 1, 'fallback mengirim audio VN')
  assert.ok(audioSends[0][1].audio.length > 200, 'audio OGG hasil konversi ffmpeg')

  // Sesi sudah dipakai -> VN berikutnya ditolak lagi.
  const m3 = { chat, sender, quoted: audioQuoted, conn, key: { ...key, id: 'x5' } }
  await assert.rejects(
    handler(m3, { conn, text: '', __dirname: dir }),
    e => e === 'Reply foto dengan .sa terlebih dahulu, lalu reply voice note atau audio dengan .sa.'
  )
})
