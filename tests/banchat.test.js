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
import { proto } from '@whiskeysockets/baileys'
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
const ownerGroupMention = (s, text, jid) => raw(text, { group: true, fromMe: true, id: s.nextId(), message: { extendedTextMessage: { text, contextInfo: { mentionedJid: [jid] } } } })
const targetDM = (s, text = '.ping') => raw(text, { id: s.nextId() })
const targetGroup = (s, text = '.ping') => raw(text, { group: true, id: s.nextId() })
// Pesan dari grup ARBITRER (bukan GROUP fixture) — untuk menguji ban
// id grup string pendek/panjang: remoteJid grup itu sendiri.
const rawFromGroup = (s, groupJid, text = '.ping') => {
  const m = proto.WebMessageInfo.fromObject({ key: { id: s.nextId(), remoteJid: groupJid, fromMe: false, participant: PN }, messageTimestamp: Date.now() / 1000, pushName: 'Test', message: { conversation: text } })
  m.key.participantAlt = LID
  return m
}

test('metadata: satu plugin menangani .banchat/.allowchat, owner-only, tanpa limit', async () => {
  assert.equal(banchat.command.test('banchat'), true)
  assert.equal(banchat.command.test('allowchat'), true)
  assert.equal(banchat.command.test('unbanchat'), true, '.unbanchat dipertahankan sebagai alias tersembunyi')
  assert.equal(banchat.command.test('banchats'), false)
  assert.equal(banchat.command.test('allowchats'), false)
  assert.equal(banchat.owner, true)
  assert.equal(banchat.limit, undefined)
  assert.equal(banchat.sharing, true, 'banchat/allowchat dibagikan ke sub-bot')
  assert.deepEqual(banchat.help, ['banchat [target]', 'allowchat [target]'])
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

test('bentuk 3 (argumen nomor 08xxx): .banchat 08xxx memblokir user itu', async t => {
  const s = await setup(t)
  await s.run([ownerGroup(s, '.banchat 081234567890')])
  assert.equal(s.db.data.chats[LID].isBanned, true)
  assert.equal(s.db.data.chats[PN].isBanned, true)
  assert.ok(s.replies().some(x => x.includes('6281234567890') && x.includes('diblokir')), s.replies())
  const before = s.replies().length
  await s.run([targetDM(s)])
  assert.equal(s.replies().length, before, 'pesan dari pengguna yang diblokir harus diabaikan')
})

test('bentuk 3 (argumen tag): .banchat @tag memblokir DM orang itu', async t => {
  const s = await setup(t)
  await s.run([ownerGroupMention(s, '.banchat @10001', LID)])
  assert.equal(s.db.data.chats[LID].isBanned, true)
  assert.equal(s.db.data.chats[PN].isBanned, true)
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

test('bentuk 3 (id grup string pendek): .banchat 123271512@g.us memblokir grup itu', async t => {
  const s = await setup(t)
  const SHORT_GROUP = '123271512@g.us'
  await s.run([ownerGroup(s, `.banchat ${SHORT_GROUP}`)])
  assert.equal(s.db.data.chats[SHORT_GROUP].isBanned, true)
  assert.ok(s.replies().some(x => x.includes('123271512') && x.includes('diblokir')), s.replies())
  const before = s.replies().length
  await s.run([rawFromGroup(s, SHORT_GROUP)])
  assert.equal(s.replies().length, before, 'pesan dari grup pendek yang diblokir harus diabaikan')
})

test('bentuk 3 (id grup string panjang): .banchat 1203630...@g.us memblokir grup itu', async t => {
  const s = await setup(t)
  const LONG_GROUP = '120363027117842341@g.us'
  await s.run([ownerGroup(s, `.banchat ${LONG_GROUP}`)])
  assert.equal(s.db.data.chats[LONG_GROUP].isBanned, true)
  const before = s.replies().length
  await s.run([rawFromGroup(s, LONG_GROUP)])
  assert.equal(s.replies().length, before, 'pesan dari grup panjang yang diblokir harus diabaikan')
})

test('bentuk 3 (angka polos tanpa @g.us): tetap nomor telepon, BUKAN grup', async t => {
  const s = await setup(t)
  await s.run([ownerGroup(s, '.banchat 123271512')])
  assert.ok(s.replies().some(x => x.includes('tidak dikenali')), s.replies())
  assert.equal(s.db.data.chats['123271512@g.us']?.isBanned ?? false, false, 'angka polos tidak boleh membuat ban grup')
  assert.equal(s.db.data.chats[GROUP].isBanned, false)
})

test('bentuk 1 (DM): .allowchat polos membuka kedua bentuk JID/LID', async t => {
  const s = await setup(t)
  s.db.ensure('chats', LID).isBanned = true
  s.db.ensure('chats', PN).isBanned = true
  await s.run([ownerDM(s, '.allowchat')])
  assert.equal(s.db.data.chats[LID].isBanned, false)
  assert.equal(s.db.data.chats[PN].isBanned, false)
  assert.ok(s.replies().some(x => x.includes('dibuka')), s.replies())
  await s.run([targetDM(s)])
  assert.ok(s.replies().includes('pong'), s.replies())
})

test('bentuk 3 (argumen nomor): .allowchat <nomor> membuka kedua bentuk', async t => {
  const s = await setup(t)
  s.db.ensure('chats', LID).isBanned = true
  s.db.ensure('chats', PN).isBanned = true
  await s.run([ownerGroup(s, `.allowchat ${PN_DIGITS}`)])
  assert.equal(s.db.data.chats[LID].isBanned, false)
  assert.equal(s.db.data.chats[PN].isBanned, false)
  await s.run([targetDM(s)])
  assert.ok(s.replies().includes('pong'), s.replies())
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
