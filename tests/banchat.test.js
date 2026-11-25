// tests/banchat.test.js — .banchat/.unbanchat (plugins/owner/banchat.js):
// tiga bentuk target (chat saat ini, reply, argumen nomor/JID/LID),
// flag isBanned ditulis ke SEMUA bentuk JID/LID, dan gerbang owner
// dipertahankan. Dijalankan lewat pipeline asli supaya pemeriksaan
// isBanned di pipeline ikut teruji (pesan dari chat yang diblokir
// diabaikan, dari chat yang dibuka diproses).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPipeline } from '../lib/plugins/pipeline.js'
import { Database } from '../lib/database/engine.js'
import { fakeConn, raw, PN, LID, BOTLID, GROUP } from './fixtures.js'
import { dayKey } from '../lib/helpers/time.js'
import banchat from '../plugins/owner/banchat.js'

const PN_DIGITS = '6281234567890'
const LID_STR = '10001@lid'

// Probe: perintah biasa yang membalas 'pong' bila pesannya diproses.
function pongPlugin() {
  const p = async (m) => { await m.reply('pong') }
  p.help = ['ping']; p.tags = ['test']; p.command = /^ping$/i; p.limit = true
  return p
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-banchat-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const db = await new Database({ dir: root }).load()
  global.db = db
  const prevLimit = global.defaultLimit
  global.defaultLimit = 50
  t.after(() => { global.defaultLimit = prevLimit })
  const conn = fakeConn({ db })
  const loader = { root, list: () => [{ id: 'owner/banchat.js', plugin: banchat }, { id: 'test/ping.js', plugin: pongPlugin() }] }
  const pipeline = createPipeline({ db, plugins: loader, config: { prefix: '.', cooldownMs: 0, maxMessageAgeSec: 120 }, log: () => {}, error: () => {} })
  const run = (messages, type = 'notify') => pipeline.handler.call(conn, { type, messages })
  t.after(async () => { await pipeline.close(); await conn.store.close() })
  // Target (pengguna fixture PN/LID): terdaftar, limit penuh.
  for (const key of [LID, PN]) {
    const u = db.ensure('users', key)
    u.registered = true; u.limitDay = dayKey(Date.now(), 'Asia/Jakarta'); u.limit = 50
  }
  db.ensure('chats', GROUP).isBanned = false
  const replies = () => conn.calls.filter(c => c.data?.text != null).map(c => c.data.text)
  let n = 0
  const nextId = () => 'b' + (++n)
  return { db, conn, run, replies, nextId }
}

// Perintah owner: fromMe (bot sendiri = owner di pipeline).
const ownerDM = (s, text) => raw(text, { fromMe: true, id: s.nextId() })
const ownerGroup = (s, text, id) => raw(text, { group: true, fromMe: true, id: id ?? s.nextId() })
const ownerGroupReply = (s, text, participant) => raw(text, { group: true, fromMe: true, id: s.nextId(), message: { extendedTextMessage: { text, contextInfo: { quotedMessage: { conversation: 'hai' }, stanzaId: 'q1', participant } } } })
const targetDM = (s, text = '.ping') => raw(text, { id: s.nextId() })
const targetGroup = (s, text = '.ping') => raw(text, { group: true, id: s.nextId() })

test('metadata: satu plugin menangani .banchat dan .unbanchat, owner-only, tanpa limit', async () => {
  assert.equal(banchat.command.test('banchat'), true)
  assert.equal(banchat.command.test('unbanchat'), true)
  assert.equal(banchat.command.test('banchats'), false)
  assert.equal(banchat.owner, true)
  assert.equal(banchat.limit, undefined)
  assert.deepEqual(banchat.help, ['banchat [target]', 'unbanchat [target]'])
  await assert.rejects(fs.stat(path.resolve('plugins/owner/unbanchat.js')), 'unbanchat.js sudah digabung ke banchat.js')
})

test('bentuk 1 (DM): .unbanchat polos membuka kedua bentuk JID/LID', async t => {
  const s = await setup(t)
  s.db.ensure('chats', LID).isBanned = true
  s.db.ensure('chats', PN).isBanned = true
  await s.run([ownerDM(s, '.unbanchat')])
  assert.equal(s.db.data.chats[LID].isBanned, false)
  assert.equal(s.db.data.chats[PN].isBanned, false)
  assert.ok(s.replies().some(x => x.includes('dibuka')), s.replies())
  await s.run([targetDM(s)])
  assert.ok(s.replies().includes('pong'), s.replies())
})

test('bentuk 1 (DM): .banchat polos memblokir kedua bentuk JID/LID', async t => {
  const s = await setup(t)
  s.db.ensure('chats', LID).isBanned = false
  s.db.ensure('chats', PN).isBanned = false
  await s.run([ownerDM(s, '.banchat')])
  assert.equal(s.db.data.chats[LID].isBanned, true)
  assert.equal(s.db.data.chats[PN].isBanned, true)
  assert.ok(s.replies().some(x => x.includes('diblokir')), s.replies())
  const before = s.replies().length
  await s.run([targetDM(s)])
  assert.equal(s.replies().length, before, 'pesan dari DM yang diblokir harus diabaikan tanpa balasan')
})

test('bentuk 3 (argumen nomor): .unbanchat <nomor> membuka kedua bentuk', async t => {
  const s = await setup(t)
  s.db.ensure('chats', LID).isBanned = true
  s.db.ensure('chats', PN).isBanned = true
  await s.run([ownerGroup(s, `.unbanchat ${PN_DIGITS}`)])
  assert.equal(s.db.data.chats[LID].isBanned, false)
  assert.equal(s.db.data.chats[PN].isBanned, false)
  await s.run([targetDM(s)])
  assert.ok(s.replies().includes('pong'), s.replies())
})

test('bentuk 3 (argumen nomor berformat): +62 dan tanda hubung tetap dikenali', async t => {
  const s = await setup(t)
  s.db.ensure('chats', LID).isBanned = true
  s.db.ensure('chats', PN).isBanned = true
  await s.run([ownerGroup(s, '.unbanchat +62 812-3456-7890')])
  assert.equal(s.db.data.chats[LID].isBanned, false)
  assert.equal(s.db.data.chats[PN].isBanned, false)
})

test('bentuk 3 (argumen LID): .banchat <lid> memblokir bentuk PN juga', async t => {
  const s = await setup(t)
  s.db.ensure('chats', LID).isBanned = false
  s.db.ensure('chats', PN).isBanned = false
  await s.run([ownerGroup(s, `.banchat ${LID_STR}`)])
  assert.equal(s.db.data.chats[LID].isBanned, true)
  assert.equal(s.db.data.chats[PN].isBanned, true, 'ban lewat LID harus menutup jalur PN juga')
  const before = s.replies().length
  await s.run([targetDM(s)])
  assert.equal(s.replies().length, before, 'pesan dari pengguna yang diblokir harus diabaikan')
})

test('bentuk 3 (argumen JID grup): .banchat <jid grup> memblokir grup itu', async t => {
  const s = await setup(t)
  await s.run([ownerGroup(s, `.banchat ${GROUP}`)])
  assert.equal(s.db.data.chats[GROUP].isBanned, true)
  const before = s.replies().length
  await s.run([targetGroup(s)])
  assert.equal(s.replies().length, before)
})

test('bentuk 2 (reply): .unbanchat reply membuka DM orang itu, grup tidak ikut berubah', async t => {
  const s = await setup(t)
  s.db.ensure('chats', LID).isBanned = true
  s.db.ensure('chats', PN).isBanned = true
  await s.run([ownerGroupReply(s, '.unbanchat', LID)])
  assert.equal(s.db.data.chats[LID].isBanned, false)
  assert.equal(s.db.data.chats[PN].isBanned, false)
  assert.equal(s.db.data.chats[GROUP].isBanned, false, 'reply tidak boleh mengubah grup itu sendiri')
  await s.run([targetDM(s)])
  assert.ok(s.replies().includes('pong'), s.replies())
})

test('bentuk 2 (reply, pengirim PN): .banchat reply memblokir DM orang itu', async t => {
  const s = await setup(t)
  s.db.ensure('chats', LID).isBanned = false
  s.db.ensure('chats', PN).isBanned = false
  await s.run([ownerGroupReply(s, '.banchat', PN)])
  assert.equal(s.db.data.chats[LID].isBanned, true)
  assert.equal(s.db.data.chats[PN].isBanned, true)
  const before = s.replies().length
  await s.run([targetDM(s)])
  assert.equal(s.replies().length, before)
})

test('bentuk 1 (grup): .banchat polos memblokir grup; .unbanchat membukanya lagi', async t => {
  const s = await setup(t)
  await s.run([ownerGroup(s, '.banchat')])
  assert.equal(s.db.data.chats[GROUP].isBanned, true)
  assert.ok(s.replies().some(x => x.includes('diblokir')), s.replies())
  const before = s.replies().length
  await s.run([targetGroup(s)])
  assert.equal(s.replies().length, before, 'pesan dari grup yang diblokir harus diabaikan')
  await s.run([ownerGroup(s, '.unbanchat')])
  assert.equal(s.db.data.chats[GROUP].isBanned, false)
  await s.run([targetGroup(s)])
  assert.ok(s.replies().includes('pong'), s.replies())
})

test('argumen tidak valid: throw string jelas, tidak ada flag berubah', async t => {
  const s = await setup(t)
  await s.run([ownerGroup(s, '.banchat xyz')])
  assert.ok(s.replies().some(x => x.includes('tidak dikenali')), s.replies())
  assert.equal(s.db.data.chats[GROUP].isBanned, false)
  assert.equal(s.db.data.chats[LID]?.isBanned ?? false, false)
})

test('gerbang owner: bukan owner tidak bisa banchat/unbanchat', async t => {
  const s = await setup(t)
  await s.run([targetGroup(s, '.banchat')])
  assert.equal(s.db.data.chats[GROUP].isBanned, false)
  assert.ok(!s.replies().some(x => x.includes('diblokir')), s.replies())
  await s.run([targetGroup(s, '.unbanchat')])
  assert.equal(s.db.data.chats[GROUP].isBanned, false)
})

test('target bot sendiri ditolak dengan pesan jelas', async t => {
  const s = await setup(t)
  await s.run([ownerGroupReply(s, '.banchat', BOTLID)])
  assert.ok(s.replies().some(x => x.includes('bot itu sendiri')), s.replies())
  assert.equal(s.db.data.chats[GROUP].isBanned, false)
})
