// tests/odelete.test.js — odelete (plugins/owner/odelete.js): varian
// owner dari .delete, TANPA PREFIX, sebagai reply. Trigger tetap
// d(?:el(?:ete)?)? — persis "d"/"del"/"delete" (keputusan Veo 2026-11-26
// 00:31 + 00:33); "odelete" hanya nama varian, BUKAN trigger.
// Batasan admin dilepas: target siapa pun; pesan bot boleh dihapus di
// grup juga. Satu-satunya batasan yang tetap: bot harus admin untuk
// hapus pesan orang lain di grup (syarat WA). Dijalankan lewat pipeline
// asli supaya gerbang owner dan isBotAdmin ikut teruji. Owner disimulasi
// lewat fromMe (isOwner mencakup fromMe).
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
import odelete from '../plugins/owner/odelete.js'

serialize()
const MEMBER = { id: '555000111222@lid', lid: '555000111222@lid', phoneNumber: '6289528749986@s.whatsapp.net', admin: null }
const ADMIN_PARTS = [
  { id: LID, phoneNumber: PN, admin: 'admin' },
  { id: BOTLID, phoneNumber: '6282234567890@s.whatsapp.net', admin: 'admin' },
]

async function setup(t, participants = [...ADMIN_PARTS, MEMBER]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-odelete-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const db = await new Database({ dir: root }).load()
  global.db = db
  const prevLimit = global.defaultLimit
  global.defaultLimit = 50
  t.after(() => { global.defaultLimit = prevLimit })
  const conn = fakeConn({ db })
  conn.groupMetadata = async id => ({ id, subject: 'Test group', participants })
  const loader = { root, list: () => [{ id: 'owner/odelete.js', plugin: odelete }] }
  const pipeline = createPipeline({ db, plugins: loader, config: { prefix: '.', cooldownMs: 0, maxMessageAgeSec: 120 }, log: () => {}, error: () => {} })
  const run = (messages, type = 'notify') => pipeline.handler.call(conn, { type, messages })
  t.after(async () => { await pipeline.close(); await conn.store.close() })
  for (const key of [LID, PN]) {
    const u = db.ensure('users', key)
    u.registered = true; u.limitDay = dayKey(Date.now(), 'Asia/Jakarta'); u.limit = 50
  }
  db.ensure('chats', GROUP).isBanned = false
  db.ensure('chats', PN).isBanned = false
  const replies = () => conn.calls.filter(c => c.data?.text != null).map(c => c.data.text)
  const deletes = () => conn.calls.filter(c => c.data?.delete).map(c => c.data.delete.id)
  let n = 0
  const nextId = () => 'o' + (++n)
  const limit = () => db.data.users[LID].limit
  return { db, conn, run, replies, deletes, nextId, limit }
}

const replyTo = (s, text, participant, { fromMe = false, group = true } = {}) =>
  raw(text, { group, fromMe, id: s.nextId(), message: { extendedTextMessage: { text, contextInfo: { quotedMessage: { conversation: 'pesan lama' }, stanzaId: 'q1', participant } } } })
const plain = (s, text, { fromMe = false, group = true } = {}) => raw(text, { group, fromMe, id: s.nextId() })

test('metadata: odelete plugin before-only, tag owner, tanpa command dan tanpa limit', () => {
  assert.equal(typeof odelete.before, 'function', 'odelete berjalan di handler.before (bukan dispatchable)')
  assert.equal(odelete.command, undefined, 'tidak ada handler.command — tidak lewat jalur dispatch/limit')
  assert.equal(odelete.limit, undefined, 'plugin owner tidak boleh pasang handler.limit')
  assert.deepEqual(odelete.tags, ['owner'])
  assert.deepEqual(odelete.help, [], 'tidak muncul di menu (perintah owner tanpa prefix tidak bisa dipanggil ".odelete")')
})

test('grup: owner reply pesan member biasa (bukan admin) lalu "del" -> terhapus (batasan target dilepas)', async t => {
  const s = await setup(t)
  await s.run([replyTo(s, 'del', MEMBER.id, { fromMe: true })])
  assert.ok(s.deletes().includes('q1'), 'odelete tidak mensyaratkan target admin: ' + JSON.stringify(s.deletes()))
  assert.equal(s.limit(), 50)
})

test('grup: owner reply pesan bot sendiri lalu "d" -> terhapus (pesan bot boleh dihapus di grup)', async t => {
  const s = await setup(t)
  await s.run([replyTo(s, 'd', BOTLID, { fromMe: true })])
  assert.ok(s.deletes().includes('q1'), 'odelete melepas batasan DM-untuk-pesan-bot: ' + JSON.stringify(s.deletes()))
  assert.equal(s.limit(), 50)
})

test('DM: owner reply pesan bot sendiri lalu "delete" -> terhapus', async t => {
  const s = await setup(t)
  await s.run([replyTo(s, 'delete', BOTLID, { fromMe: true, group: false })])
  assert.ok(s.deletes().includes('q1'), JSON.stringify(s.deletes()))
})

test('DM: owner reply pesan lawan bicara lalu "del" -> dibalas jelas, tidak terhapus (syarat WA)', async t => {
  const s = await setup(t)
  await s.run([replyTo(s, 'del', PN, { fromMe: true, group: false })])
  assert.ok(s.replies().some(x => x.includes('tidak bisa menghapus pesan orang lain di DM')), s.replies())
  assert.deepEqual(s.deletes(), [])
})

test('grup: owner reply pesan member lalu "del" tapi bot bukan admin -> dibalas jelas, tidak terhapus', async t => {
  const noBotAdmin = [
    { id: LID, phoneNumber: PN, admin: 'admin' },
    { id: BOTLID, phoneNumber: '6282234567890@s.whatsapp.net', admin: null },
    MEMBER,
  ]
  const s = await setup(t, noBotAdmin)
  await s.run([replyTo(s, 'del', MEMBER.id, { fromMe: true })])
  assert.ok(s.replies().some(x => x.includes('Bot harus jadi admin')), s.replies())
  assert.deepEqual(s.deletes(), [])
})

test('teks tidak persis ("del dong") tidak memicu apa-apa', async t => {
  const s = await setup(t)
  await s.run([replyTo(s, 'del dong', MEMBER.id, { fromMe: true })])
  assert.deepEqual(s.deletes(), [])
  assert.deepEqual(s.replies(), [], 'tidak ada penolakan berisik untuk pesan biasa')
})

test('non-owner: reply lalu "del" tanpa prefix tidak memicu apa-apa', async t => {
  const s = await setup(t)
  await s.run([replyTo(s, 'del', MEMBER.id)])
  assert.deepEqual(s.deletes(), [])
  assert.deepEqual(s.replies(), [], 'bukan owner -> pesan mengalir normal tanpa penolakan')
})

test('owner "del" tanpa reply -> diam (trigger mensyaratkan reply)', async t => {
  const s = await setup(t)
  await s.run([plain(s, 'del', { fromMe: true })])
  assert.deepEqual(s.deletes(), [])
  assert.deepEqual(s.replies(), [], 'tanpa reply bukan trigger odelete')
})

test('"odelete" BUKAN trigger: owner reply lalu ketik "odelete" -> tidak memicu apa-apa', async t => {
  const s = await setup(t)
  await s.run([replyTo(s, 'odelete', MEMBER.id, { fromMe: true })])
  assert.deepEqual(s.deletes(), [])
  assert.deepEqual(s.replies(), [], '"odelete" hanya nama varian, bukan kata trigger (koreksi Veo 2026-11-26 00:33)')
})
