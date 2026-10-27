import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createIdentity, normalize, phoneDigits } from '../lib/identity/resolver.js'
import { smsg, decorateSocket } from '../lib/simple.js'
import { Database } from '../lib/database/engine.js'
import { OutboundQueue } from '../lib/helpers/queue.js'
import { raw, fakeConn, LID, PN, GROUP } from './fixtures.js'
test('normalization removes devices; does not equate unmapped PN/LID', () => { const id = createIdentity({ conn: {} }); assert.equal(normalize('10001:2@lid'), LID); assert.equal(normalize('123:2@c.us'), '123@s.whatsapp.net'); assert.equal(id.same('10001@s.whatsapp.net', LID), false) })
test('PN to LID from alternative keys and mapping; unresolved safe fallback', async () => { for (const group of [false, true]) { const conn = fakeConn(); const m = smsg(conn, raw('hi', { group })); await conn.identity.prime(m); assert.equal(m.sender, LID); assert.equal(m.senderJid, PN); await conn.store.close() } const conn = fakeConn(); assert.equal(await conn.toLid(PN), LID); const unknown = smsg(conn, raw('hi', { alt: false })); const identity = createIdentity({ conn: { user: {} } }); await identity.prime(unknown); assert.equal(unknown.senderUnresolved, true); assert.equal(unknown.sender, PN); await conn.store.close() })
test('group participant phone mapping, local typed input, ambiguous mention and unknown', async () => { const conn = fakeConn({ mapping: false }); const id = conn.identity; const ctx = { participants: [{ id: LID, phoneNumber: PN }] }; assert.equal(await id.toJid(LID, ctx), PN); assert.equal(phoneDigits('081234567890', '62'), '6281234567890'); assert.equal((await id.resolve('@10001', ctx)).lid, LID); const unknown = await id.resolve('@6283234567890'); assert.equal(unknown.source, 'typed-unverified'); assert.equal(unknown.lid, null); await conn.store.close() })
test('alias migration merges users and private-chat records without duplicates; role mapping', async t => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-id-')); t.after(() => fs.rm(dir, { force: true, recursive: true })); const db = await new Database({ dir }).load(); db.ensure('users', PN).limit = 7; db.ensure('chats', PN).welcome = true; const id = createIdentity({ conn: {}, db, options: { aliasMigration: true }, roles: { founder: [['6281234567890', '', 'Owner']] } }); id.learn({ lid: LID, jid: PN }); assert.equal(db.data.users[PN], undefined); assert.equal(db.data.users[LID].limit, 7); assert.equal(db.data.chats[LID].welcome, true); assert.equal(id.roleOf(LID).isFounder, true); assert.equal(id.roleOf(PN).isFounder, true) })
test('action fallback retries each failure once with alternative; unknown PN rejected', async () => { const calls = []; const sock = { user: {}, sendMessage: async () => {}, async groupParticipantsUpdate(jid, ids) { calls.push(ids); return ids.map(jid => ({ jid, status: calls.length === 1 ? '403' : '200' })) } }; decorateSocket(sock, { outbound: new OutboundQueue({ perChatMs: 0, perSecond: 100 }) }); sock.identity.learn({ lid: LID, jid: PN }); const result = await sock.groupParticipantsUpdate(GROUP, [LID], 'remove'); assert.deepEqual(calls, [[PN], [LID]]); assert.equal(result[0].status, '200'); await assert.rejects(sock.identity.forAction(['999@lid'], 'remove'), e => typeof e === 'string') })
test('sendMessage wrapper meneruskan target newsletter; target sampah tetap ditolak', async () => {
  const sent = []
  const sock = { user: {}, sendMessage: async (jid, value) => { sent.push({ jid, value }); return { key: { id: 'x' } } } }
  decorateSocket(sock, { outbound: new OutboundQueue({ perChatMs: 0, perSecond: 100 }) })
  // Regresi .bcc 2026-10-27: JID @newsletter sempat ditolak 'Target
  // tidak valid' oleh allowlist wrapper ini sebelum sampai ke Baileys.
  await sock.sendMessage('120363430242683071@newsletter', { text: 'Hai' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].jid, '120363430242683071@newsletter')
  assert.equal(sent[0].value.text, 'Hai')
  await assert.rejects(sock.sendMessage('bukan-jid', { text: 'x' }), /Target tidak valid/)
})
test('validator can be disabled; record fallback otherwise used', async () => { const db = { data: { users: { [LID]: { lid: LID, jid: PN } }, chats: {} }, ensure(name, key, seed) { return Object.assign(this.data[name][key], seed) } }; const off = createIdentity({ conn: {}, db, options: { validate: false } }); assert.equal((await off.resolve(PN)).lid, null); const on = createIdentity({ conn: {}, db, options: { validate: true } }); assert.equal((await on.resolve(PN)).lid, LID) })
