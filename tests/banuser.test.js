// tests/banuser.test.js — .banuser/.unbanuser (plugins/owner/banuser.js,
// unbanuser.js + lib/helpers/moderation.js): target reply/tag/nomor
// (628xxx dan 08xxx), tanpa argumen di DM = lawan bicara, ban nomor
// yang LID-nya belum diketahui (record JID, digabung ke LID begitu
// pemetaan dipelajari), dan gerbang owner/bot. Dijalankan lewat
// pipeline asli supaya gerbang user.isBanned di pipeline ikut teruji
// (pesan dari user yang di-ban diabaikan di DM maupun grup).
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
import banuser from '../plugins/owner/banuser.js'
import unbanuser from '../plugins/owner/unbanuser.js'

const PN_DIGITS = '6281234567890'
const KNOWN_08 = '081234567890'
const UNSEEN_DIGITS = '6289998887777'
const UNSEEN_JID = UNSEEN_DIGITS + '@s.whatsapp.net'
const UNSEEN_LID = '99999@lid'

function pongPlugin() {
  const p = async (m) => { await m.reply('pong') }
  p.help = ['ping']; p.tags = ['test']; p.command = /^ping$/i; p.limit = true
  return p
}

async function setup(t, { sub = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-banuser-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const db = await new Database({ dir: root, ...(sub ? { sub: true } : {}) }).load()
  const prevDb = global.db
  global.db = db
  t.after(() => { global.db = prevDb })
  const prevLimit = global.defaultLimit
  global.defaultLimit = 50
  t.after(() => { global.defaultLimit = prevLimit })
  const conn = fakeConn({ db, role: sub ? 'sub' : 'main' })
  const loader = { root, list: () => [
    { id: 'owner/banuser.js', plugin: banuser },
    { id: 'owner/unbanuser.js', plugin: unbanuser },
    { id: 'test/ping.js', plugin: pongPlugin() },
  ] }
  const pipeline = createPipeline({ db, plugins: loader, config: { prefix: '.', cooldownMs: 0, maxMessageAgeSec: 120 }, log: () => {}, error: () => {} })
  const run = (messages, type = 'notify') => pipeline.handler.call(conn, { type, messages })
  t.after(async () => { await pipeline.close(); await conn.store.close() })
  for (const key of [LID, PN]) {
    const u = db.ensure('users', key)
    u.registered = true; u.limitDay = dayKey(Date.now(), 'Asia/Jakarta'); u.limit = 50
  }
  db.ensure('chats', GROUP).isBanned = false
  // DM lawan bicara juga harus dibuka: record chats baru default
  // isBanned: true (desain Veo) — tanpa ini .ping target tidak pernah
  // sampai ke handler, dan tes gerbang user.isBanned tidak bermakna.
  db.ensure('chats', PN).isBanned = false
  db.ensure('chats', LID).isBanned = false
  const replies = () => conn.calls.filter(c => c.data?.text != null).map(c => c.data.text)
  let n = 0
  const nextId = () => 'u' + (++n)
  return { db, conn, run, replies, nextId }
}

// Perintah owner: fromMe (bot sendiri = owner di pipeline).
const ownerDM = (s, text) => raw(text, { fromMe: true, id: s.nextId() })
const ownerGroup = (s, text, id) => raw(text, { group: true, fromMe: true, id: id ?? s.nextId() })
const ownerGroupReply = (s, text, participant) => raw(text, { group: true, fromMe: true, id: s.nextId(), message: { extendedTextMessage: { text, contextInfo: { quotedMessage: { conversation: 'hai' }, stanzaId: 'q1', participant } } } })
const ownerGroupMention = (s, text, jid) => raw(text, { group: true, fromMe: true, id: s.nextId(), message: { extendedTextMessage: { text, contextInfo: { mentionedJid: [jid] } } } })
const targetDM = (s, text = '.ping') => raw(text, { id: s.nextId() })
const targetGroup = (s, text = '.ping') => raw(text, { group: true, id: s.nextId() })
// Pesan pertama dari nomor yang belum dikenal: remoteJid LID-nya +
// remoteJidAlt nomornya — pipeline mempelajari pemetaan dari sini.
const firstContact = (s, lid, pn, text = '.ping') => {
  const m = proto.WebMessageInfo.fromObject({ key: { id: s.nextId(), remoteJid: lid, fromMe: false }, messageTimestamp: Date.now() / 1000, pushName: 'Unseen', message: { conversation: text } })
  m.key.remoteJidAlt = pn
  return m
}

test('metadata: banuser/unbanuser owner-only, tanpa limit, dibagikan ke sub-bot', async () => {
  assert.equal(banuser.command.test('banuser'), true)
  assert.equal(unbanuser.command.test('unbanuser'), true)
  assert.equal(banuser.command.test('banusers'), false)
  assert.equal(banuser.owner, true)
  assert.equal(unbanuser.owner, true)
  assert.equal(banuser.limit, undefined)
  assert.equal(unbanuser.limit, undefined)
  assert.equal(banuser.sharing, true, 'banuser dibagikan ke sub-bot')
  assert.equal(unbanuser.sharing, true, 'unbanuser dibagikan ke sub-bot')
  assert.deepEqual(banuser.help, ['banuser [target]'])
  assert.deepEqual(unbanuser.help, ['unbanuser [target]'])
})

test('.banuser 628xxx: user di-ban (DM + grup diabaikan), .unbanuser membukanya', async t => {
  const s = await setup(t)
  await s.run([ownerDM(s, '.banuser ' + PN_DIGITS)])
  assert.deepEqual(s.replies(), ['Pengguna ' + PN_DIGITS + ' diblokir.'])
  assert.equal(s.db.data.users[LID]?.banned, true)
  await s.run([targetDM(s)])
  await s.run([targetGroup(s)])
  assert.deepEqual(s.replies(), ['Pengguna ' + PN_DIGITS + ' diblokir.'], 'pesan user yang di-ban tidak diproses')
  await s.run([ownerDM(s, '.unbanuser ' + PN_DIGITS)])
  assert.deepEqual(s.replies(), ['Pengguna ' + PN_DIGITS + ' diblokir.', 'Blokir pengguna ' + PN_DIGITS + ' dicabut.'])
  assert.equal(s.db.data.users[LID]?.banned, false)
  await s.run([targetDM(s)])
  assert.ok(s.replies().includes('pong'), 'sesudah unban, .ping diproses lagi')
})

test('.banuser 08xxx: angka 0 depan diubah ke 62', async t => {
  const s = await setup(t)
  await s.run([ownerDM(s, '.banuser ' + KNOWN_08)])
  assert.deepEqual(s.replies(), ['Pengguna ' + PN_DIGITS + ' diblokir.'])
  assert.equal(s.db.data.users[LID]?.banned, true)
})

test('.banuser reply dan @tag di grup', async t => {
  const s = await setup(t)
  await s.run([ownerGroupReply(s, '.banuser', PN)])
  assert.equal(s.db.data.users[LID]?.banned, true)
  await s.run([ownerGroupReply(s, '.unbanuser', PN)])
  assert.equal(s.db.data.users[LID]?.banned, false)
  await s.run([ownerGroupMention(s, '.banuser @10001', LID)])
  assert.equal(s.db.data.users[LID]?.banned, true)
  await s.run([ownerGroupMention(s, '.unbanuser @10001', LID)])
  assert.equal(s.db.data.users[LID]?.banned, false)
})

test('.banuser tanpa argumen di DM: targetnya lawan bicara', async t => {
  const s = await setup(t)
  await s.run([ownerDM(s, '.banuser')])
  assert.deepEqual(s.replies(), ['Pengguna ' + PN_DIGITS + ' diblokir.'])
  assert.equal(s.db.data.users[LID]?.banned, true)
})

test('.banuser tanpa argumen di DM yang lawan bicaranya owner: pesan pemakaian', async t => {
  const s = await setup(t)
  const prevOwner = globalThis.owner
  globalThis.owner = [[PN_DIGITS, '10001', 'Test']]
  t.after(() => { globalThis.owner = prevOwner })
  await s.run([ownerDM(s, '.banuser')])
  assert.match(s.replies()[0], /Siapa yang mau diblokir\?/)
  assert.equal(s.db.data.users[LID]?.banned, false, 'owner tidak ikut ke-ban')
})

test('.banuser tanpa argumen di grup: pesan pemakaian, bukan "belum terverifikasi"', async t => {
  const s = await setup(t)
  await s.run([ownerGroup(s, '.banuser')])
  assert.match(s.replies()[0], /Siapa yang mau diblokir\?/)
})

test('.banuser id grup: ditolak dengan arahan ke .banchat', async t => {
  const s = await setup(t)
  await s.run([ownerDM(s, '.banuser 123271512@g.us')])
  assert.match(s.replies()[0], /Itu id grup — pakai \.banchat/)
})

test('.banuser nomor tak dikenal: ban tersimpan di record JID', async t => {
  const s = await setup(t)
  await s.run([ownerDM(s, '.banuser ' + UNSEEN_DIGITS)])
  assert.match(s.replies()[0], new RegExp('Pengguna ' + UNSEEN_DIGITS + ' diblokir\\.'))
  assert.match(s.replies()[0], /Pemetaan LID belum diketahui/)
  assert.equal(s.db.data.users[UNSEEN_JID]?.banned, true, 'ban tersimpan keyed by JID')
  assert.equal(s.db.data.users[UNSEEN_JID]?.jid, UNSEEN_JID)
})

test('ban nomor tak dikenal AKTIF begitu dia pertama kali berinteraksi (merge JID→LID)', async t => {
  const s = await setup(t)
  await s.run([ownerDM(s, '.banuser ' + UNSEEN_DIGITS)])
  assert.equal(s.db.data.users[UNSEEN_JID]?.banned, true)
  // Pesan pertama si nomor tak dikenal: LID + nomornya sebagai alt.
  await s.run([firstContact(s, UNSEEN_LID, UNSEEN_JID)])
  assert.equal(s.db.data.users[UNSEEN_LID]?.banned, true, 'ban ikut terbawa ke record LID')
  assert.equal(s.db.data.users[UNSEEN_JID], undefined, 'record JID digabung lalu dihapus')
  assert.ok(!s.replies().some(r => r === 'pong'), 'pesan pertamanya sudah diabaikan')
})

test('.unbanuser nomor tak dikenal tanpa record: tidak membuat record', async t => {
  const s = await setup(t)
  await s.run([ownerDM(s, '.unbanuser ' + UNSEEN_DIGITS)])
  assert.match(s.replies()[0], /tidak sedang diblokir/)
  assert.equal(s.db.data.users[UNSEEN_JID], undefined)
})

test('.unbanuser nomor tak dikenal yang sudah di-ban (record JID): ban dicabut', async t => {
  const s = await setup(t)
  await s.run([ownerDM(s, '.banuser ' + UNSEEN_DIGITS)])
  assert.equal(s.db.data.users[UNSEEN_JID]?.banned, true)
  await s.run([ownerDM(s, '.unbanuser ' + UNSEEN_DIGITS)])
  assert.ok(s.replies().some(r => /Blokir pengguna 6289998887777 dicabut\./.test(r)), s.replies())
  assert.equal(s.db.data.users[UNSEEN_JID]?.banned, false)
})

test('target bot sendiri ditolak', async t => {
  const s = await setup(t)
  await s.run([ownerDM(s, '.banuser ' + BOTLID)])
  assert.match(s.replies()[0], /botnya sendiri/)
  assert.equal(s.db.data.users[BOTLID]?.banned, false, 'record bot ada (dibuat pipeline sebagai pengirim) tapi tidak di-ban')
})

test('sub-bot: ban di sandbox tidak bocor ke bot utama', async t => {
  const main = await setup(t)
  const sub = await setup(t, { sub: true })
  // Ban di sub-bot (global.db saat ini = db sub — kembalikan ke main sesudahnya).
  const prevDb = global.db
  global.db = sub.db
  t.after(() => { global.db = prevDb })
  await sub.run([ownerDM(sub, '.banuser ' + PN_DIGITS)])
  assert.equal(sub.db.data.users[LID]?.banned, true)
  assert.equal(main.db.data.users[LID]?.banned, false, 'bot utama tidak ikut nge-ban')
})
