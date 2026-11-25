// tests/premiumCommands.test.js — .addpremium/.addprem dan
// .delpremium/.delprem (plugins/owner/premium.js): parsing durasi
// multi-label (d/w/m dijumlahkan), matematika masa berlaku (baru dari
// sekarang, perpanjang dari masa berlaku lama, permanen tak berubah),
// resolusi target (argumen nomor/JID/LID, mention, reply, DM), dan
// gerbang owner. Dijalankan lewat pipeline asli.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPipeline } from '../lib/plugins/pipeline.js'
import { Database } from '../lib/database/engine.js'
import { fakeConn, raw, PN, LID, BOTLID, GROUP } from './fixtures.js'
import { dayKey } from '../lib/helpers/time.js'
import premium from '../plugins/owner/premium.js'

const PN_DIGITS = '6281234567890'
const LID_STR = '10001@lid'
const BOTLID_STR = '20002@lid'
const DAY_MS = 86400000
const TOL = 60000 // toleransi jam dinding (perintah jalan < 1 detik)
const approx = (actual, expected) => Math.abs(actual - expected) < TOL

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-premiumcmd-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const db = await new Database({ dir: root }).load()
  global.db = db
  const prevLimit = global.defaultLimit
  global.defaultLimit = 50
  t.after(() => { global.defaultLimit = prevLimit })
  const conn = fakeConn({ db })
  const loader = { root, list: () => [{ id: 'owner/premium.js', plugin: premium }] }
  const pipeline = createPipeline({ db, plugins: loader, config: { prefix: '.', cooldownMs: 0, maxMessageAgeSec: 120 }, log: () => {}, error: () => {} })
  const run = (messages, type = 'notify') => pipeline.handler.call(conn, { type, messages })
  t.after(async () => { await pipeline.close(); await conn.store.close() })
  const u = db.ensure('users', LID)
  u.registered = true; u.limitDay = dayKey(Date.now(), 'Asia/Jakarta'); u.limit = 50
  const replies = () => conn.calls.filter(c => c.data?.text != null).map(c => c.data.text)
  let n = 0
  const nextId = () => 'p' + (++n)
  return { db, conn, run, replies, nextId }
}

const ownerDM = (s, text) => raw(text, { fromMe: true, id: s.nextId() })
const ownerGroup = (s, text, id) => raw(text, { group: true, fromMe: true, id: id ?? s.nextId() })
const ownerGroupReply = (s, text, participant) => raw(text, { group: true, fromMe: true, id: s.nextId(), message: { extendedTextMessage: { text, contextInfo: { quotedMessage: { conversation: 'hai' }, stanzaId: 'q1', participant } } } })
const ownerGroupMention = (s, text, mentioned) => raw(text, { group: true, fromMe: true, id: s.nextId(), message: { extendedTextMessage: { text, contextInfo: { mentionedJid: mentioned } } } })
const targetGroup = (s, text = '.ping') => raw(text, { group: true, id: s.nextId() })
const target = s => s.db.data.users[LID]

test('metadata: satu plugin menangani addprem/addpremium/delprem/delpremium, owner-only, tanpa limit', async () => {
  for (const cmd of ['addpremium', 'addprem', 'delpremium', 'delprem']) assert.equal(premium.command.test(cmd), true)
  assert.equal(premium.command.test('addpremiums'), false)
  assert.equal(premium.command.test('prem'), false)
  assert.equal(premium.owner, true)
  assert.equal(premium.limit, undefined)
  assert.deepEqual(premium.help, ['addpremium <target> <durasi>', 'delpremium <target>'])
})

test('durasi multi-label: .addprem <nomor> 1w 5d = 12 hari dari sekarang', async t => {
  const s = await setup(t)
  const before = Date.now()
  await s.run([ownerGroup(s, `.addprem ${PN_DIGITS} 1w 5d`)])
  const u = target(s)
  assert.equal(u.premium, true)
  assert.ok(approx(u.premiumTime, before + 12 * DAY_MS), `premiumTime ${u.premiumTime} vs ${before + 12 * DAY_MS}`)
  assert.ok(s.replies().some(x => x.includes('12 hari')), s.replies())
  assert.ok(s.replies().some(x => x.includes(PN_DIGITS)), s.replies())
})

test('satuan: 1d = 1 hari, 1w = 7 hari, 1m = 30 hari, 1m 1w 1d = 38 hari', async t => {
  for (const [dur, days] of [['1d', 1], ['1w', 7], ['1m', 30], ['1m 1w 1d', 38]]) {
    const s2 = await setup(t)
    const before = Date.now()
    await s2.run([ownerGroup(s2, `.addpremium ${PN_DIGITS} ${dur}`)])
    assert.ok(approx(target(s2).premiumTime, before + days * DAY_MS), `${dur}: ${target(s2).premiumTime} vs ${before + days * DAY_MS}`)
  }
})

test('satuan huruf besar: 1W 5D sama dengan 1w 5d', async t => {
  const s = await setup(t)
  const before = Date.now()
  await s.run([ownerGroup(s, `.ADDPREM ${PN_DIGITS} 1W 5D`)])
  assert.ok(approx(target(s).premiumTime, before + 12 * DAY_MS))
})

test('perpanjang: premium aktif 5 hari lagi + 1w = masa berlaku lama + 7 hari', async t => {
  const s = await setup(t)
  const u = target(s)
  u.premium = true
  const old = u.premiumTime = Date.now() + 5 * DAY_MS
  await s.run([ownerGroup(s, `.addprem ${PN_DIGITS} 1w`)])
  assert.ok(approx(target(s).premiumTime, old + 7 * DAY_MS), `premiumTime ${target(s).premiumTime} vs ${old + 7 * DAY_MS}`)
  // Sisa = 12 hari kurang beberapa milidetik eksekusi -> tampil "11 hari 23 jam ...".
  assert.ok(s.replies().some(x => x.includes('Sisa premium: 11 hari')), s.replies())
})

test('kedaluwarsa: premium habis kemarin + 1w = dari sekarang + 7 hari', async t => {
  const s = await setup(t)
  const u = target(s)
  u.premium = true; u.premiumTime = Date.now() - DAY_MS
  const before = Date.now()
  await s.run([ownerGroup(s, `.addprem ${PN_DIGITS} 1w`)])
  assert.ok(approx(target(s).premiumTime, before + 7 * DAY_MS))
  assert.equal(target(s).premium, true)
})

test('permanen: premiumTime 0 tidak berubah, balas info permanen', async t => {
  const s = await setup(t)
  const u = target(s)
  u.premium = true; u.premiumTime = 0
  await s.run([ownerGroup(s, `.addprem ${PN_DIGITS} 1w`)])
  assert.equal(target(s).premium, true)
  assert.equal(target(s).premiumTime, 0)
  assert.ok(s.replies().some(x => x.includes('permanen')), s.replies())
})

test('delpremium: mencabut premium + premiumTime', async t => {
  const s = await setup(t)
  const u = target(s)
  u.premium = true; u.premiumTime = Date.now() + 5 * DAY_MS
  await s.run([ownerGroup(s, `.delprem ${PN_DIGITS}`)])
  assert.equal(target(s).premium, false)
  assert.equal(target(s).premiumTime, 0)
  assert.ok(s.replies().some(x => x.includes('dicabut')), s.replies())
})

test('delpremium: user yang tidak premium -> info, bukan eror', async t => {
  const s = await setup(t)
  await s.run([ownerGroup(s, `.delpremium ${PN_DIGITS}`)])
  assert.equal(target(s).premium, false)
  assert.ok(s.replies().some(x => x.includes('tidak premium')), s.replies())
})

test('target reply: .addprem 1w sambil reply (LID) -> record LID', async t => {
  const s = await setup(t)
  const before = Date.now()
  await s.run([ownerGroupReply(s, '.addprem 1w', LID)])
  assert.ok(approx(target(s).premiumTime, before + 7 * DAY_MS))
  assert.equal(target(s).premium, true)
})

test('target reply: .delprem sambil reply (PN) -> premium dicabut', async t => {
  const s = await setup(t)
  const u = target(s)
  u.premium = true; u.premiumTime = Date.now() + 5 * DAY_MS
  await s.run([ownerGroupReply(s, '.delprem', PN)])
  assert.equal(target(s).premium, false)
  assert.equal(target(s).premiumTime, 0)
})

test('target mention: .addprem @sailox 1w 5d -> 12 hari', async t => {
  const s = await setup(t)
  const before = Date.now()
  await s.run([ownerGroupMention(s, '.addprem @sailox 1w 5d', [LID])])
  assert.ok(approx(target(s).premiumTime, before + 12 * DAY_MS), `premiumTime ${target(s).premiumTime} vs ${before + 12 * DAY_MS}`)
})

test('target LID: .addprem <lid> 2d -> 2 hari', async t => {
  const s = await setup(t)
  const before = Date.now()
  await s.run([ownerGroup(s, `.addprem ${LID_STR} 2d`)])
  assert.ok(approx(target(s).premiumTime, before + 2 * DAY_MS))
})

test('target nomor terbelah: .addprem +62 812-3456-7890 1w -> 7 hari', async t => {
  const s = await setup(t)
  const before = Date.now()
  await s.run([ownerGroup(s, '.addprem +62 812-3456-7890 1w')])
  assert.ok(approx(target(s).premiumTime, before + 7 * DAY_MS))
})

test('target DM: .addprem 1w di DM -> lawan bicara (record LID)', async t => {
  const s = await setup(t)
  const before = Date.now()
  await s.run([ownerDM(s, '.addprem 1w')])
  assert.ok(approx(target(s).premiumTime, before + 7 * DAY_MS))
})

test('tanpa target di grup: .addprem 1w -> lempar pemakaian, tidak ada yang berubah', async t => {
  const s = await setup(t)
  await s.run([ownerGroup(s, '.addprem 1w')])
  assert.equal(target(s).premium, false)
  assert.equal(target(s).premiumTime, 0)
  assert.ok(s.replies().some(x => x.includes('Cara pakai')), s.replies())
})

test('tanpa durasi: .addprem <nomor> -> lempar pemakaian durasi', async t => {
  const s = await setup(t)
  await s.run([ownerGroup(s, `.addprem ${PN_DIGITS}`)])
  assert.equal(target(s).premium, false)
  assert.ok(s.replies().some(x => x.includes('Cara pakai')), s.replies())
  assert.ok(s.replies().some(x => x.includes('Durasi')), s.replies())
})

test('durasi tidak valid: 3x tidak dikenali, 0d ditolak', async t => {
  const s = await setup(t)
  await s.run([ownerGroup(s, `.addprem ${PN_DIGITS} 3x`)])
  assert.equal(target(s).premium, false)
  assert.ok(s.replies().some(x => x.includes('tidak dikenali')), s.replies())
  await s.run([ownerGroup(s, `.addprem ${PN_DIGITS} 0d`)])
  assert.equal(target(s).premium, false)
  assert.ok(s.replies().some(x => x.includes('tidak valid')), s.replies())
})

test('dua target: .addprem <nomor> <lid> 1w -> ditolak', async t => {
  const s = await setup(t)
  await s.run([ownerGroup(s, `.addprem ${PN_DIGITS} ${LID_STR} 1w`)])
  assert.equal(target(s).premium, false)
  assert.ok(s.replies().some(x => x.includes('satu target')), s.replies())
})

test('delpremium + durasi: .delprem <nomor> 1w -> lempar pemakaian del', async t => {
  const s = await setup(t)
  const u = target(s)
  u.premium = true; u.premiumTime = Date.now() + 5 * DAY_MS
  await s.run([ownerGroup(s, `.delprem ${PN_DIGITS} 1w`)])
  assert.equal(target(s).premium, true, 'premium harus tetap karena perintah ditolak')
  assert.ok(s.replies().some(x => x.includes('Cara pakai')), s.replies())
})

test('gerbang owner: bukan owner tidak bisa add/del premium', async t => {
  const s = await setup(t)
  await s.run([targetGroup(s, `.addprem ${PN_DIGITS} 1w`)])
  assert.equal(target(s).premium, false)
  assert.ok(!s.replies().some(x => x.includes('ditambahkan')), s.replies())
  const u = target(s)
  u.premium = true; u.premiumTime = Date.now() + 5 * DAY_MS
  await s.run([targetGroup(s, `.delprem ${PN_DIGITS}`)])
  assert.equal(target(s).premium, true)
})

test('target bot sendiri ditolak (argumen LID bot dan reply bot)', async t => {
  const s = await setup(t)
  await s.run([ownerGroup(s, `.addprem ${BOTLID_STR} 1w`)])
  assert.ok(s.replies().some(x => x.includes('bot itu sendiri')), s.replies())
  await s.run([ownerGroupReply(s, '.addprem 1w', BOTLID)])
  assert.ok(s.replies().some(x => x.includes('bot itu sendiri')), s.replies())
  assert.equal(s.db.data.users[BOTLID]?.premium ?? false, false)
})
