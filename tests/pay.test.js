// tests/pay.test.js — .pay / .qris / .setqris (plugins/info/pay.js):
// .pay mengirim gambar QRIS sebagai image (bukan dokumen) dan BEBAS
// limit (keputusan Veo 2026-11-25); .setqris owner-only, menimpa
// src/public/images/Payment.jpg dari gambar yang dikirim / di-reply. Dijalankan lewat pipeline asli
// supaya gerbang owner (di dalam handler), limit, dan registrasi ikut
// teruji. Jalur QRIS ditimpa ke file sementara lewat setQrisPath —
// Payment.jpg asli tidak pernah ditulis tes ini.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPipeline } from '../lib/plugins/pipeline.js'
import { Database } from '../lib/database/engine.js'
import { fakeConn, raw, PN, LID, GROUP } from './fixtures.js'
import { dayKey } from '../lib/helpers/time.js'
import { smsg, serialize } from '../lib/simple.js'
import pay, { setQrisPath, getQrisPath } from '../plugins/info/pay.js'

serialize()
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='
const PNG = () => Buffer.from(PNG_B64, 'base64')
const REAL_QRIS = path.resolve('src/public/images/Payment.jpg')

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
// Perintah .setqris sambil me-reply sebuah media (stanzaId 'q1').
const setqrisReply = (quotedMessage, id) => raw('.setqris', {
  fromMe: true, id, message: { extendedTextMessage: { text: '.setqris', contextInfo: { stanzaId: 'q1', participant: PN, quotedMessage } } },
})

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-pay-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const db = await new Database({ dir: root }).load()
  global.db = db
  const prevLimit = global.defaultLimit
  global.defaultLimit = 50
  t.after(() => { global.defaultLimit = prevLimit })
  const conn = fakeConn({ db })
  const loader = { root, list: () => [{ id: 'info/pay.js', plugin: pay }] }
  const pipeline = createPipeline({ db, plugins: loader, config: { prefix: '.', cooldownMs: 0, maxMessageAgeSec: 120 }, log: () => {}, error: () => {} })
  const run = (messages, type = 'notify') => pipeline.handler.call(conn, { type, messages })
  t.after(async () => { await pipeline.close(); await conn.store.close() })
  // Pengguna fixture (PN/LID): terdaftar, limit penuh.
  for (const key of [LID, PN]) {
    const u = db.ensure('users', key)
    u.registered = true; u.limitDay = dayKey(Date.now(), 'Asia/Jakarta'); u.limit = 50
  }
  db.ensure('chats', GROUP).isBanned = false
  const replies = () => conn.calls.filter(c => c.data?.text != null).map(c => c.data.text)
  let n = 0
  const nextId = () => 'p' + (++n)
  return { db, conn, run, replies, nextId, root }
}

const userGroup = (s, text = '.pay') => raw(text, { group: true, id: s.nextId() })
const ownerDM = (s, text = '.setqris') => raw(text, { fromMe: true, id: s.nextId() })

test('metadata: .pay/.qris/.setqris satu plugin, bebas limit, tag info, tanpa handler.owner', () => {
  assert.equal(pay.command.test('pay'), true)
  assert.equal(pay.command.test('qris'), true)
  assert.equal(pay.command.test('setqris'), true)
  assert.equal(pay.command.test('Pay'), true)
  assert.equal(pay.command.test('payx'), false)
  assert.equal(pay.limit, undefined, 'bebas limit — keputusan Veo 2026-11-25')
  assert.equal(pay.owner, undefined, 'gerbang owner .setqris ada di dalam handler, bukan handler.owner (lihat komentar plugin)')
  assert.deepEqual(pay.tags, ['info'])
  assert.deepEqual(pay.help, ['pay', 'qris', 'setqris'])
})

test('.pay mengirim gambar QRIS asli sebagai image (bukan dokumen)', async t => {
  const s = await setup(t)
  await s.run([userGroup(s, '.pay')])
  const sent = s.conn.calls.find(c => c.data?.image)
  assert.ok(sent, 'ada pesan image terkirim')
  assert.deepEqual(sent.data.image, await fs.readFile(REAL_QRIS), 'isi gambar = Payment.jpg')
  assert.equal(sent.data.mimetype, 'image/jpeg')
  assert.equal(sent.data.fileName, 'QRIS.jpg')
  assert.equal(sent.jid, GROUP)
})

test('.qris alias mengirim gambar yang sama', async t => {
  const s = await setup(t)
  await s.run([userGroup(s, '.qris')])
  const sent = s.conn.calls.find(c => c.data?.image)
  assert.ok(sent, 'alias .qris juga mengirim gambar')
  assert.deepEqual(sent.data.image, await fs.readFile(REAL_QRIS))
})

test('.pay tidak makan limit untuk user biasa', async t => {
  const s = await setup(t)
  await s.run([userGroup(s, '.pay')])
  assert.equal(s.db.data.users[LID].limit, 50)
})

test('.setqris owner dengan reply gambar menimpa file QRIS (jalur sementara)', async t => {
  const s = await setup(t)
  const tmpQris = path.join(s.root, 'Payment.jpg')
  await fs.copyFile(REAL_QRIS, tmpQris)
  const origPath = getQrisPath()
  setQrisPath(tmpQris)
  try {
    // Unduhan langsung dari salinan quote gagal (tanpa URL) — fallback
    // mengambil pesan asli dari store bot, yang download-nya di-stub
    // mengembalikan PNG kecil (pola tests/mediaResolve.test.js).
    const original = smsg(s.conn, raw('', { id: 'q1', message: imgInner(true) }))
    Object.defineProperty(original, 'download', { value: async () => PNG() })
    s.conn.store.push([original])
    await s.run([setqrisReply(imgInner(false), s.nextId())])
    assert.deepEqual(await fs.readFile(tmpQris), PNG(), 'file QRIS kini berisi gambar baru')
    assert.ok(s.replies().some(x => x.includes('berhasil diganti')), s.replies())
  } finally {
    setQrisPath(origPath)
  }
})

test('.setqris oleh non-owner ditolak, file tidak berubah', async t => {
  const s = await setup(t)
  const tmpQris = path.join(s.root, 'Payment.jpg')
  await fs.copyFile(REAL_QRIS, tmpQris)
  const origPath = getQrisPath()
  setQrisPath(tmpQris)
  try {
    await s.run([userGroup(s, '.setqris')])
    assert.ok(s.replies().some(x => x.includes('khusus owner')), s.replies())
    assert.deepEqual(await fs.readFile(tmpQris), await fs.readFile(REAL_QRIS), 'file QRIS utuh')
  } finally {
    setQrisPath(origPath)
  }
})

test('.setqris tanpa gambar -> pesan pemakaian', async t => {
  const s = await setup(t)
  await s.run([ownerDM(s, '.setqris')])
  assert.ok(s.replies().some(x => x.includes('Kirim/reply gambar')), s.replies())
})

test('.setqris reply video ditolak, file tidak berubah', async t => {
  const s = await setup(t)
  const tmpQris = path.join(s.root, 'Payment.jpg')
  await fs.copyFile(REAL_QRIS, tmpQris)
  const origPath = getQrisPath()
  setQrisPath(tmpQris)
  try {
    await s.run([setqrisReply(vidInner(), s.nextId())])
    assert.ok(s.replies().some(x => x.includes('bukan gambar')), s.replies())
    assert.deepEqual(await fs.readFile(tmpQris), await fs.readFile(REAL_QRIS), 'file QRIS utuh')
  } finally {
    setQrisPath(origPath)
  }
})

test('.pay saat file QRIS hilang -> pesan jelas, bukan eror generik', async t => {
  const s = await setup(t)
  const origPath = getQrisPath()
  setQrisPath(path.join(s.root, 'tidak-ada.jpg'))
  try {
    await s.run([userGroup(s, '.pay')])
    assert.ok(s.replies().some(x => x.includes('belum tersedia')), s.replies())
  } finally {
    setQrisPath(origPath)
  }
})
