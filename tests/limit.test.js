// tests/limit.test.js — ekonomi limit di pipeline (lib/plugins/pipeline.js):
// deduksi saat sukses, bebas saat throw, pembebasan m.limit = 0,
// pra-cek limit habis, pengecualian mods/premium, dan reset harian.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPipeline } from '../lib/plugins/pipeline.js'
import { Database } from '../lib/database/engine.js'
import { fakeConn, raw, PN, LID } from './fixtures.js'
import { dayKey } from '../lib/helpers/time.js'

function okPlugin(limit, fn = async () => {}) {
  const p = fn
  p.help = ['test']; p.tags = ['test']; p.command = /^ping$/i
  if (limit !== undefined) p.limit = limit
  return p
}

async function setup(t, plugins, userPatch = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-limit-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const db = await new Database({ dir: root }).load()
  global.db = db
  const prevLimit = global.defaultLimit
  global.defaultLimit = 50
  t.after(() => { global.defaultLimit = prevLimit })
  const conn = fakeConn({ db })
  const loader = { root, list: () => plugins.map((plugin, i) => ({ id: 'test' + i + '.js', plugin })) }
  const pipeline = createPipeline({ db, plugins: loader, config: { prefix: '.', cooldownMs: 0, maxMessageAgeSec: 120 }, log: () => {}, error: () => {} })
  const run = (messages, type = 'notify') => pipeline.handler.call(conn, { type, messages })
  t.after(async () => { await pipeline.close(); await conn.store.close() })
  const users = db.ensure('users', LID)
  const usersPN = db.ensure('users', PN)
  for (const u of [users, usersPN]) { u.registered = true; u.limitDay = dayKey(Date.now(), 'Asia/Jakarta'); u.limit = 50; Object.assign(u, userPatch) }
  db.ensure('chats', PN).isBanned = false
  db.ensure('chats', LID).isBanned = false
  const replies = () => conn.calls.filter(c => c.data?.text != null).map(c => c.data.text)
  return { db, conn, pipeline, run, user: () => db.data.users[LID], replies }
}

test('limit: pengguna baru mendapat limit bawaan 50', async t => {
  const { db } = await setup(t, [])
  const u = db.ensure('users', '99999@lid')
  assert.equal(u.limit, 50)
  assert.equal(u.limitDay, '')
})

test('limit: sukses memotong 1 (limit=true)', async t => {
  const { run, pipeline, user } = await setup(t, [okPlugin(true)])
  await run([raw('.ping', { id: 'l1' })])
  assert.equal(user().limit, 49)
})

test('limit: biaya nominal memotong sebesar nominalnya', async t => {
  const { run, pipeline, user } = await setup(t, [okPlugin(3)])
  await run([raw('.ping', { id: 'l2' })])
  assert.equal(user().limit, 47)
})

test('limit: throw string (usage) tidak memotong', async t => {
  const { run, pipeline, user, replies } = await setup(t, [okPlugin(true, async () => { throw 'Kirim gambar dulu.' })])
  await run([raw('.ping', { id: 'l3' })])
  assert.equal(user().limit, 50)
  assert.ok(replies().some(x => x.includes('Kirim gambar dulu.')), replies())
})

test('limit: throw Error tidak memotong', async t => {
  const { run, pipeline, user } = await setup(t, [okPlugin(true, async () => { throw new Error('boom') })])
  await run([raw('.ping', { id: 'l4' })])
  assert.equal(user().limit, 50)
})

test('limit: mods bebas limit (tidak memotong, tetap jalan walau limit 0)', async t => {
  const prevMods = global.mods
  global.mods = [[PN.replace('@s.whatsapp.net', ''), 'Mod']]
  t.after(() => { global.mods = prevMods })
  const { run, pipeline, user } = await setup(t, [okPlugin(true)])
  user().limit = 0
  await run([raw('.ping', { id: 'l5' })])
  assert.equal(user().limit, 0, 'mods tidak dipotong')
})

test('limit: premium bebas limit (unlimited, jalan walau limit 0)', async t => {
  const { run, pipeline, user } = await setup(t, [okPlugin(true)], { premium: true, premiumTime: 0 })
  user().limit = 0
  await run([raw('.ping', { id: 'l6' })])
  assert.equal(user().limit, 0, 'premium tidak dipotong')
})

test('limit: premium kedaluwarsa diperlakukan sebagai non-premium', async t => {
  const { run, pipeline, user } = await setup(t, [okPlugin(true)], { premium: true, premiumTime: Date.now() - 1000 })
  await run([raw('.ping', { id: 'l7' })])
  assert.equal(user().premium, false)
  assert.equal(user().premiumTime, 0)
  assert.equal(user().limit, 49)
})

test('limit: limit tidak cukup ditolak SEBELUM handler jalan, dengan sisa limit', async t => {
  let ran = false
  const { run, pipeline, user, replies } = await setup(t, [okPlugin(true, async () => { ran = true })])
  user().limit = 0
  await run([raw('.ping', { id: 'l8' })])
  assert.equal(ran, false, 'handler tidak boleh jalan')
  assert.equal(user().limit, 0)
  assert.ok(replies().some(x => x.includes('Limit lo tidak cukup') && x.includes('sisa 0')), replies())
})

test('limit: reset harian — limitDay kemarin + limit 0 -> isi ulang 50 lalu potong 1', async t => {
  const { run, pipeline, user } = await setup(t, [okPlugin(true)])
  user().limitDay = dayKey(Date.now() - 86400000, 'Asia/Jakarta')
  user().limit = 0
  await run([raw('.ping', { id: 'l9' })])
  assert.equal(user().limit, 49)
  assert.equal(user().limitDay, dayKey(Date.now(), 'Asia/Jakarta'))
})

// Perubahan spek atas perintah eksplisit Veo (2026-11-25): isi ulang
// harian HANYA bila limit sudah habis. Sisa yang masih ada dibawa ke
// hari berikutnya — tidak direset, tidak ditambah.
test('limit: reset harian HANYA bila habis — limitDay kemarin + limit 30 -> sisa dibawa, potong 1', async t => {
  const { run, pipeline, user } = await setup(t, [okPlugin(true)])
  user().limitDay = dayKey(Date.now() - 86400000, 'Asia/Jakarta')
  user().limit = 30
  await run([raw('.ping', { id: 'l9b' })])
  assert.equal(user().limit, 29)
  assert.equal(user().limitDay, dayKey(Date.now(), 'Asia/Jakarta'))
})

test('limit: hari yang sama tidak mereset', async t => {
  const { run, pipeline, user } = await setup(t, [okPlugin(true)])
  user().limit = 5
  await run([raw('.ping', { id: 'l10' })])
  assert.equal(user().limit, 4)
})

test('limit: handler boleh membebaskan pemakaian dengan m.limit = 0', async t => {
  const { run, pipeline, user } = await setup(t, [okPlugin(true, async m => { m.limit = 0 })])
  await run([raw('.ping', { id: 'l11' })])
  assert.equal(user().limit, 50)
})
