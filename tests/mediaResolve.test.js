import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { smsg, serialize } from '../lib/simple.js'
import { silentLogger } from '../lib/helpers/silentLogger.js'
import { raw, fakeConn, PN } from './fixtures.js'
import { resolveMediaTarget, stickerKindFor, downloadMediaWithFallback, MediaGoneError } from '../lib/media/resolve.js'
import stickerPlugin from '../plugins/sticker/sticker.js'
import rvoPlugin from '../plugins/tools/rvo.js'

serialize()
global.namebot = 'Sailox'
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='
const PNG = () => Buffer.from(PNG_B64, 'base64')

const imgInner = (withUrl = true) => ({
  imageMessage: {
    mimetype: 'image/jpeg', caption: '', fileLength: 1234,
    jpegThumbnail: Buffer.from([1, 2, 3]),
    ...(withUrl ? { url: 'https://127.0.0.1:1/foto.jpg', mediaKey: Buffer.alloc(32, 7) } : {}),
  },
})
const vidInner = () => ({
  videoMessage: {
    mimetype: 'video/mp4', caption: '', seconds: 5, fileLength: 123456,
    url: 'https://127.0.0.1:1/video.mp4', mediaKey: Buffer.alloc(32, 8),
    jpegThumbnail: Buffer.from([1, 2, 3]),
  },
})
const docInner = (mimetype = 'image/png', fileName = 'gambar.png') => ({
  documentMessage: {
    mimetype, fileName, fileLength: 4321,
    url: 'https://127.0.0.1:1/gambar.png', mediaKey: Buffer.alloc(32, 9),
  },
})
const cmdWithQuote = (quotedMessage, id = 'cmd1') => raw('.s', {
  id, message: { extendedTextMessage: { text: '.s', contextInfo: { stanzaId: 'q1', participant: PN, quotedMessage } } },
})
// Conn minimal untuk resolver: downloadM + loadMessage dikendalikan tes.
function plainConn({ downloadM = async () => PNG(), storeMap = new Map() } = {}) {
  return {
    downloadM,
    loadMessage: id => storeMap.get(id),
    store: { loadMessage: id => storeMap.get(id) },
    identity: { self: [], same: () => false },
  }
}

test('resolveMediaTarget: pesan sendiri didahulukan, lalu reply', () => {
  const conn = plainConn()
  const ownImg = smsg(conn, raw('', { message: imgInner(true) }))
  assert.equal(resolveMediaTarget(ownImg).via, 'own')
  assert.equal(resolveMediaTarget(ownImg).mtype, 'imageMessage')
  const ownDoc = smsg(conn, raw('', { message: docInner() }))
  assert.equal(resolveMediaTarget(ownDoc).mtype, 'documentMessage')
  assert.equal(resolveMediaTarget(ownDoc).mime, 'image/png')
  const textOnly = smsg(conn, raw('halo'))
  assert.equal(resolveMediaTarget(textOnly), null)
  const qImg = smsg(conn, cmdWithQuote(imgInner(true)))
  assert.equal(resolveMediaTarget(qImg).via, 'quoted')
  assert.equal(resolveMediaTarget(qImg).mtype, 'imageMessage')
})

test('resolveMediaTarget: quote once-view terurai ke media dalamnya', () => {
  const conn = plainConn()
  const qVoImg = smsg(conn, cmdWithQuote({ viewOnceMessageV2: { message: imgInner(true) } }))
  const t1 = resolveMediaTarget(qVoImg)
  assert.equal(t1.via, 'quoted')
  assert.equal(t1.mtype, 'imageMessage')
  assert.equal(t1.mediaType, 'image')
  const qVoVid = smsg(conn, cmdWithQuote({ viewOnceMessageV2: { message: vidInner() } }))
  assert.equal(resolveMediaTarget(qVoVid).mtype, 'videoMessage')
  const qDoc = smsg(conn, cmdWithQuote(docInner('video/mp4', 'vid.mp4')))
  assert.equal(resolveMediaTarget(qDoc).mtype, 'documentMessage')
  const qText = smsg(conn, cmdWithQuote({ conversation: 'teks' }))
  assert.equal(resolveMediaTarget(qText), null)
})

test('stickerKindFor: gambar/video/GIF/dokumen dipetakan, lainnya ditolak', () => {
  const conn = plainConn()
  const kind = msg => stickerKindFor(resolveMediaTarget(smsg(conn, msg)))
  assert.equal(kind(raw('', { message: imgInner(true) })), 'image')
  assert.equal(kind(raw('', { message: vidInner() })), 'video')
  assert.equal(kind(raw('', { message: { stickerMessage: { fileLength: 10 } } })), 'image')
  assert.equal(kind(raw('', { message: docInner('image/png', 'a.png') })), 'image')
  assert.equal(kind(raw('', { message: docInner('image/gif', 'a.gif') })), 'video')
  assert.equal(kind(raw('', { message: docInner('video/mp4', 'a.mp4') })), 'video')
  assert.equal(kind(raw('', { message: docInner('application/pdf', 'a.pdf') })), null)
  assert.equal(kind(raw('', { message: { documentMessage: { fileName: 'foto.jpg', fileLength: 10 } } })), 'image')
  assert.equal(kind(raw('', { message: { audioMessage: { mimetype: 'audio/ogg', fileLength: 10 } } })), null)
  assert.equal(stickerKindFor(null), null)
})

test('downloadMediaWithFallback: quote once-view tanpa URL jatuh ke asli di store', async () => {
  const storeMap = new Map()
  const conn = plainConn({ storeMap })
  // Asli di store (punya URL) dengan id yang sama dengan stanzaId quote.
  const original = smsg(conn, raw('', { id: 'q1', message: { viewOnceMessageV2: { message: imgInner(true) } } }))
  Object.defineProperty(original, 'download', { value: async () => PNG() })
  storeMap.set('q1', original)
  // Perintah .s me-reply quote once-view TANPA url.
  const m = smsg(conn, cmdWithQuote({ viewOnceMessageV2: { message: imgInner(false) } }))
  const target = resolveMediaTarget(m)
  assert.equal(target.via, 'quoted')
  // Unduhan salinan quote gagal (tidak ada URL) — stub di instance quote.
  Object.defineProperty(target.msg, 'download', { value: async () => { throw new Error('No valid media URL or directPath present in message') } })
  const buf = await downloadMediaWithFallback(conn, target)
  assert.ok(Buffer.isBuffer(buf) && buf.length > 0, 'buffer datang dari pesan asli di store')
})

test('downloadMediaWithFallback: asli tidak ada di store -> MediaGoneError', async () => {
  const conn = plainConn({ storeMap: new Map() })
  const m = smsg(conn, cmdWithQuote({ viewOnceMessageV2: { message: imgInner(false) } }))
  const target = resolveMediaTarget(m)
  Object.defineProperty(target.msg, 'download', { value: async () => { throw new Error('No valid media URL or directPath present in message') } })
  await assert.rejects(() => downloadMediaWithFallback(conn, target), MediaGoneError)
})

test('downloadMediaWithFallback: pesan sendiri langsung, tanpa fallback', async () => {
  const conn = plainConn()
  const m = smsg(conn, raw('', { message: imgInner(true) }))
  const target = resolveMediaTarget(m)
  Object.defineProperty(target.msg, 'download', { value: async () => PNG() })
  const buf = await downloadMediaWithFallback(conn, target)
  assert.ok(buf.equals(PNG()))
})

test('plugin .rvo: quote once-view tanpa URL terkirim lagi sebagai pesan biasa', async t => {
  const conn = fakeConn()
  const storeMap = new Map()
  const original = smsg(conn, raw('', { id: 'q1', message: { viewOnceMessageV2: { message: imgInner(true) } } }))
  Object.defineProperty(original, 'download', { value: async () => PNG() })
  conn.store.push([original])
  const m = smsg(conn, cmdWithQuote({ viewOnceMessageV2: { message: imgInner(false) } }))
  Object.defineProperty(m.quoted, 'download', { value: async () => { throw new Error('No valid media URL or directPath present in message') } })
  await rvoPlugin.call(conn, m, { conn })
  const sent = conn.calls.find(c => c.data?.image)
  assert.ok(sent, 'media terkirim lagi sebagai image biasa (tanpa once-view)')
  await conn.store.close()
})

test('plugin .rvo: tanpa media -> pesan pemakaian (bukan crash)', async t => {
  const conn = fakeConn()
  const m = smsg(conn, raw('.rvo'))
  await assert.rejects(() => rvoPlugin.call(conn, m, { conn }), /Reply media once-view/)
  await conn.store.close()
})

test('plugin .s: dokumen gambar + quote once-view jadi stiker', async t => {
  const conn = fakeConn()
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const ctx = { conn, text: '', __dirname: path.join(dir, '..', 'plugins', 'sticker') }
  // Dokumen gambar sebagai reply.
  const mDoc = smsg(conn, cmdWithQuote(docInner('image/png', 'gambar.png')))
  Object.defineProperty(mDoc.quoted, 'download', { value: async () => PNG() })
  await stickerPlugin.call(conn, mDoc, ctx)
  assert.ok(conn.calls.find(c => c.data?.sticker), 'dokumen gambar terkirim sebagai stiker')
  // Quote once-view tanpa URL + asli di store.
  const original = smsg(conn, raw('', { id: 'q1', message: { viewOnceMessageV2: { message: imgInner(true) } } }))
  Object.defineProperty(original, 'download', { value: async () => PNG() })
  conn.store.push([original])
  const mVo = smsg(conn, cmdWithQuote({ viewOnceMessageV2: { message: imgInner(false) } }, 'cmd2'))
  Object.defineProperty(mVo.quoted, 'download', { value: async () => { throw new Error('No valid media URL or directPath present in message') } })
  await stickerPlugin.call(conn, mVo, ctx)
  assert.ok(conn.calls.filter(c => c.data?.sticker).length >= 2, 'quote once-view terkirim sebagai stiker via fallback store')
  await conn.store.close()
})

// ── Format ASLI once-view (hasil eval m.quoted Veo 2026-11-13) ───────────
// Quote once-view ternyata BUKAN bungkusan viewOnceMessageV2: melainkan
// media telanjang (imageMessage/videoMessage) dengan flag viewOnce:true,
// LENGKAP dengan url + mediaKey + directPath. Jadi unduhan langsung dari
// quote bisa jalan; fallback store hanya jaring pengaman.

const voRealImg = () => ({
  imageMessage: {
    mimetype: 'image/jpeg', caption: '.rvo', fileLength: 1234,
    url: 'https://127.0.0.1:1/foto.jpg', mediaKey: Buffer.alloc(32, 7),
    directPath: '/o1/v/foto.jpg', viewOnce: true,
    jpegThumbnail: Buffer.from([1, 2, 3]),
  },
})
const voRealVid = () => ({
  videoMessage: {
    mimetype: 'video/mp4', caption: '.s', seconds: 3, fileLength: 123456,
    url: 'https://127.0.0.1:1/video.mp4', mediaKey: Buffer.alloc(32, 8),
    directPath: '/v/video.mp4', viewOnce: true,
    jpegThumbnail: Buffer.from([1, 2, 3]),
  },
})

test('format asli: quote once-view telanjang + viewOnce:true, URL ada di quote', () => {
  const conn = plainConn()
  const tImg = resolveMediaTarget(smsg(conn, cmdWithQuote(voRealImg())))
  assert.equal(tImg.via, 'quoted')
  assert.equal(tImg.mtype, 'imageMessage')
  assert.equal(tImg.mediaType, 'image')
  assert.ok(String(tImg.msg.msg.url).startsWith('https://'), 'quote membawa URL media')
  assert.equal(stickerKindFor(tImg), 'image')
  const tVid = resolveMediaTarget(smsg(conn, cmdWithQuote(voRealVid())))
  assert.equal(tVid.mtype, 'videoMessage')
  assert.equal(tVid.msg.msg.seconds, 3)
  assert.equal(stickerKindFor(tVid), 'video')
})

test('format asli: downloadMediaMessage mengekstrak media dari quote (gagal di fetch, bukan di ekstraksi)', async () => {
  const conn = plainConn()
  const q = smsg(conn, cmdWithQuote(voRealImg())).quoted
  await assert.rejects(
    () => downloadMediaMessage(q, 'stream', { options: { signal: AbortSignal.timeout(5000) } }, { logger: silentLogger, reuploadRequest: async m => m }),
    /fetch failed/,
    'ekstraksi berhasil (URL ketemu) — hanya fetch ke URL palsu yang gagal',
  )
})

test('plugin .s + .rvo: quote once-view format asli langsung jadi stiker / terkirim ulang', async t => {
  const conn = fakeConn()
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const ctx = { conn, text: '', __dirname: path.join(dir, '..', 'plugins', 'sticker') }
  const mS = smsg(conn, cmdWithQuote(voRealVid(), 'cmd-vo-s'))
  Object.defineProperty(mS.quoted, 'download', { value: async () => PNG() })
  await stickerPlugin.call(conn, mS, ctx)
  assert.ok(conn.calls.find(c => c.data?.sticker), 'once-view video format asli jadi stiker')
  const mRvo = smsg(conn, cmdWithQuote(voRealImg(), 'cmd-vo-rvo'))
  Object.defineProperty(mRvo.quoted, 'download', { value: async () => PNG() })
  await rvoPlugin.call(conn, mRvo, { conn })
  assert.ok(conn.calls.find(c => c.data?.image), 'once-view gambar format asli terkirim ulang sebagai pesan biasa')
  await conn.store.close()
})
