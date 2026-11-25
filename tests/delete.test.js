// tests/delete.test.js — .delete / .del / .d (plugins/group/delete.js):
// hapus pesan lewat reply, versi biasa (ber-prefix). Versi owner
// (odelete, tanpa prefix) diuji di tests/odelete.test.js. Dijalankan
// lewat pipeline asli supaya gerbang (registrasi, admin grup, bot admin)
// dan limit ikut teruji.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPipeline } from '../lib/plugins/pipeline.js'
import { Database } from '../lib/database/engine.js'
import { fakeConn, raw, PN, LID, BOTLID, GROUP } from './fixtures.js'
import { dayKey } from '../lib/helpers/time.js'
import { serialize } from '../lib/simple.js'
import del from '../plugins/group/delete.js'

serialize()
const MEMBER = { id: '555000111222@lid', lid: '555000111222@lid', phoneNumber: '6289528749986@s.whatsapp.net', admin: null }
const ADMIN_PARTS = [
  { id: LID, phoneNumber: PN, admin: 'admin' },
  { id: BOTLID, phoneNumber: '6282234567890@s.whatsapp.net', admin: 'admin' },
]

async function setup(t, participants = [...ADMIN_PARTS, MEMBER]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-delete-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const db = await new Database({ dir: root }).load()
  global.db = db
  const prevLimit = global.defaultLimit
  global.defaultLimit = 50
  t.after(() => { global.defaultLimit = prevLimit })
  const conn = fakeConn({ db })
  conn.groupMetadata = async id => ({ id, subject: 'Test group', participants })
  const loader = { root, list: () => [{ id: 'group/delete.js', plugin: del }] }
  const pipeline = createPipeline({ db, plugins: loader, config: { prefix: '.', cooldownMs: 0, maxMessageAgeSec: 120 }, log: () => {}, error: () => {} })
  const run = (messages, type = 'notify') => pipeline.handler.call(conn, { type, messages })
  t.after(async () => { await pipeline.close(); await conn.store.close() })
  for (const key of [LID, PN]) {
    const u = db.ensure('users', key)
    u.registered = true; u.limitDay = dayKey(Date.now(), 'Asia/Jakarta'); u.limit = 50
  }
  db.ensure('chats', GROUP).isBanned = false
  // Chat DM (PN) juga dibuka — record chats default-nya isBanned true,
  // dan pipeline mengabaikan pesan dari chat yang diblokir.
  db.ensure('chats', PN).isBanned = false
  const replies = () => conn.calls.filter(c => c.data?.text != null).map(c => c.data.text)
  const deletes = () => conn.calls.filter(c => c.data?.delete).map(c => c.data.delete.id)
  let n = 0
  const nextId = () => 'd' + (++n)
  const limit = () => db.data.users[LID].limit
  return { db, conn, run, replies, deletes, nextId, limit }
}

// Pesan yang me-reply pesan lain (stanzaId 'q1'). `sender` = pengirim
// perintah (default PN/LID = admin di setup); `alt: false` bila sender
// bukan LID agar participantAlt tidak salah menunjuk ke LID.
const replyTo = (s, text, participant, { fromMe = false, group = true, sender, alt } = {}) =>
  raw(text, { group, fromMe, id: s.nextId(), participant: sender, alt, message: { extendedTextMessage: { text, contextInfo: { quotedMessage: { conversation: 'pesan lama' }, stanzaId: 'q1', participant } } } })
const plain = (s, text, { fromMe = false, group = true } = {}) => raw(text, { group, fromMe, id: s.nextId() })

test('metadata: .delete/.del/.d satu plugin, tag group, bebas limit; trigger persis d/del/delete', () => {
  assert.equal(del.command.test('delete'), true)
  assert.equal(del.command.test('del'), true)
  assert.equal(del.command.test('d'), true)
  assert.equal(del.command.test('Delete'), true)
  assert.equal(del.command.test('deletex'), false)
  assert.equal(del.command.test('dd'), false)
  assert.equal(del.command.test('odelete'), false, '"odelete" BUKAN trigger — itu nama varian owner (plugins/owner/odelete.js)')
  assert.equal(del.limit, undefined, 'fitur grup bebas limit — keputusan Veo 2026-11-25')
  assert.deepEqual(del.tags, ['group'])
  assert.equal(del.before, undefined, 'versi owner pindah ke plugins/owner/odelete.js (bukan lagi handler.before di sini)')
})

test('grup: .delete reply pesan admin (bot admin) berhasil + pesan perintah ikut terhapus, limit tetap 50', async t => {
  const s = await setup(t)
  const cmd = replyTo(s, '.delete', LID)
  await s.run([cmd])
  assert.ok(s.deletes().includes('q1'), 'pesan target terhapus: ' + JSON.stringify(s.deletes()))
  assert.ok(s.deletes().includes(cmd.key.id), 'pesan perintah ikut terhapus: ' + JSON.stringify(s.deletes()))
  assert.ok(s.conn.calls.some(c => c.data?.react?.text === '✅'), 'ada reaksi ✅ sebagai konfirmasi')
  assert.equal(s.limit(), 50)
})

test('grup: .del reply pesan member biasa ditolak (target harus admin)', async t => {
  const s = await setup(t)
  await s.run([replyTo(s, '.del', MEMBER.id)])
  assert.ok(s.replies().some(x => x.includes('hanya menghapus pesan dari admin')), s.replies())
  assert.deepEqual(s.deletes(), [], 'tidak ada pesan yang terhapus')
  assert.equal(s.limit(), 50)
})

test('grup: .d ditolak bila bot bukan admin', async t => {
  const noBotAdmin = [
    { id: LID, phoneNumber: PN, admin: 'admin' },
    { id: BOTLID, phoneNumber: '6282234567890@s.whatsapp.net', admin: null },
    MEMBER,
  ]
  const s = await setup(t, noBotAdmin)
  await s.run([replyTo(s, '.d', LID)])
  assert.ok(s.replies().some(x => x.includes('Bot harus jadi admin')), s.replies())
  assert.deepEqual(s.deletes(), [])
  assert.equal(s.limit(), 50)
})

test('DM: .delete reply pesan bot sendiri berhasil, tanpa pesan sukses (keputusan Veo 2026-11-26 ~01:01)', async t => {
  const s = await setup(t)
  await s.run([replyTo(s, '.delete', BOTLID, { group: false })])
  assert.ok(s.deletes().includes('q1'), 'pesan bot terhapus: ' + JSON.stringify(s.deletes()))
  assert.deepEqual(s.replies(), [], 'tidak ada pesan sukses — hilangnya pesan itu sendiri konfirmasinya')
  assert.equal(s.limit(), 50)
})

test('grup: .delete reply pesan bot sendiri oleh admin berhasil (koreksi Veo 2026-11-26 ~00:54, KDN)', async t => {
  const s = await setup(t)
  const cmd = replyTo(s, '.delete', BOTLID)
  await s.run([cmd])
  assert.ok(s.deletes().includes('q1'), 'pesan bot terhapus: ' + JSON.stringify(s.deletes()))
  assert.ok(s.deletes().includes(cmd.key.id), 'pesan perintah ikut terhapus: ' + JSON.stringify(s.deletes()))
  assert.ok(s.conn.calls.some(c => c.data?.react?.text === '✅'), 'ada reaksi ✅ sebagai konfirmasi')
  assert.equal(s.limit(), 50)
})

test('grup: .delete reply pesan bot sendiri oleh member biasa ditolak (pengirim harus admin)', async t => {
  const s = await setup(t)
  const u = s.db.ensure('users', MEMBER.id)
  u.registered = true; u.limitDay = dayKey(Date.now(), 'Asia/Jakarta'); u.limit = 50
  await s.run([replyTo(s, '.delete', BOTLID, { sender: MEMBER.id, alt: false })])
  assert.ok(s.replies().some(x => x.includes('hanya admin yang boleh menghapus pesan bot')), s.replies())
  assert.deepEqual(s.deletes(), [], 'tidak ada pesan yang terhapus')
  assert.equal(s.limit(), 50)
})

test('grup: .delete reply pesan bot sendiri oleh admin, bot BUKAN admin -> pesan bot terhapus, pesan perintah DILEWATKAN tanpa pemberitahuan (koreksi Veo 2026-11-26 ~01:01)', async t => {
  const noBotAdmin = [
    { id: LID, phoneNumber: PN, admin: 'admin' },
    { id: BOTLID, phoneNumber: '6282234567890@s.whatsapp.net', admin: null },
    MEMBER,
  ]
  const s = await setup(t, noBotAdmin)
  const cmd = replyTo(s, '.delete', BOTLID)
  await s.run([cmd])
  assert.ok(s.deletes().includes('q1'), 'pesan bot terhapus walau bot bukan admin: ' + JSON.stringify(s.deletes()))
  assert.ok(!s.deletes().includes(cmd.key.id), 'pesan perintah TIDAK ikut dihapus — dilewatkan, bukan dicoba: ' + JSON.stringify(s.deletes()))
  assert.deepEqual(s.replies(), [], 'tanpa pemberitahuan apa pun')
  assert.equal(s.limit(), 50)
})

test('DM: .delete reply pesan orang lain ditolak (group-only)', async t => {
  const s = await setup(t)
  await s.run([replyTo(s, '.delete', LID, { group: false })])
  assert.ok(s.replies().some(x => x.includes('hanya bisa di grup')), s.replies())
  assert.deepEqual(s.deletes(), [])
})

test('.delete tanpa reply -> pesan pemakaian', async t => {
  const s = await setup(t)
  await s.run([plain(s, '.delete')])
  assert.ok(s.replies().some(x => x.includes('Reply pesan yang mau dihapus')), s.replies())
  assert.deepEqual(s.deletes(), [])
})

test('regresi KDN 2026-11-26: cache metadata basi (bot bukan admin) + refresh paksa -> .delete berhasil', async t => {
  const s = await setup(t)
  const stale = [
    { id: LID, phoneNumber: PN, admin: 'admin' },
    { id: BOTLID, phoneNumber: '6282234567890@s.whatsapp.net', admin: null },
    MEMBER,
  ]
  // Prime cache dengan metadata basi: bot BUKAN admin (seolah promosi
  // yang kelewat event saat reconnect).
  s.conn.groupMetadata = async id => ({ id, subject: 'Test group', participants: stale })
  await s.conn.store.getGroupMetadata(GROUP)
  // Server kini bilang bot SUDAH admin (promosi sudah terjadi).
  s.conn.groupMetadata = async id => ({ id, subject: 'Test group', participants: [...ADMIN_PARTS, MEMBER] })
  await s.run([replyTo(s, '.delete', LID)])
  assert.ok(s.deletes().includes('q1'), 'refresh paksa mengambil status admin segar: ' + JSON.stringify(s.deletes()))
  assert.ok(!s.replies().some(x => x.includes('Bot harus jadi admin')), s.replies())
})
