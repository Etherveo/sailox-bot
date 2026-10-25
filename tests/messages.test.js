import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { proto } from '@whiskeysockets/baileys'
import { protoType, serialize, smsg } from '../lib/simple.js'
import { createStore } from '../lib/store.js'
import { raw, fakeConn, PN, LID, GROUP } from './fixtures.js'
test('prototype helpers idempotent, nonenumerable, strict number and conversions', () => { protoType(); protoType(); assert.equal(Object.getOwnPropertyDescriptor(String.prototype, 'capitalize').enumerable, false); assert.equal('12x'.isNumber(), false); assert.equal('12.5'.isNumber(), true); assert.equal(''.isNumber(), false); assert.deepEqual(Buffer.from([1, 2]).toArrayBuffer().toBuffer(), Buffer.from([1, 2])); assert.equal((61000).toTimeString(), '1 menit 1 detik') })
test('serialization retains instance and alt; wrappers, text override, quote and methods', async () => { serialize(); serialize(); const conn = fakeConn(); const instance = raw('', { message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'hello', contextInfo: { stanzaId: 'quoted1', participant: PN, quotedMessage: { conversation: 'quoted' } } } } } } }); const m = smsg(conn, instance); assert.equal(m, instance); assert.equal(m.key.remoteJidAlt, LID); assert.equal(m.text, 'hello'); assert.equal(m.quoted.text, 'quoted'); assert.equal(m.quoted.id, 'quoted1'); m.text = '.ping'; assert.equal(m.text, '.ping'); assert.equal(Object.keys(m).includes('conn'), false); await conn.identity.prime(m); assert.equal(m.sender, LID); assert.equal(m.chat, LID); assert.equal(m.senderJid, PN); assert.equal(m.quoted.sender, LID); assert.equal(m.copy().key.remoteJidAlt, LID); assert.equal(smsg(conn, null), null); await conn.store.close() })
test('outbound sends captured in store for retries with original signature', async () => { const conn = fakeConn(); const m = await conn.reply(PN, 'Pong'); assert.equal(conn.store.getMessage(m.key).conversation, 'Pong'); assert.equal(conn.calls[0].data.text, 'Pong'); await conn.store.close() })
test('store LRU/TTL and deduplicated metadata; updates invalidate permissions', async () => { let now = 0; const store = createStore({ maxMessages: 2, messageTTL: 10, now: () => now, wait: async () => {} }); const conn = fakeConn({ store }); store.push([raw('a', { id: 'a' }), raw('b', { id: 'b' }), raw('c', { id: 'c' })]); assert.equal(store.loadMessage('a'), undefined); assert.equal(store.size, 2); now = 11; assert.equal(store.loadMessage('c'), undefined); const [a, b] = await Promise.all([store.getGroupMetadata(GROUP), store.getGroupMetadata(GROUP)]); assert.equal(a, b); assert.equal(conn.calls.filter(c => c.metadata).length, 1); store.markRevoked('b'); await store.close() })
test('file helper detects content and rejects over-size without network', async () => { const conn = fakeConn(); const f = await conn.getFile(Buffer.from('hello')); assert.equal(f.mime, 'application/octet-stream'); await assert.rejects(conn.getFile(Buffer.alloc(151 * 1024 * 1024)), /terlalu besar/); await conn.store.close() })
test('sendFile asDocument memaksa document untuk video; tanpa opsi tetap video', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-doc-'))
  t.after(() => fs.rm(dir, { force: true, recursive: true }))
  const header = Buffer.alloc(32)
  header.writeUInt32BE(24, 0)
  header.write('ftyp', 4)
  header.write('isom', 8)
  const mp4 = path.join(dir, 'ep.mp4')
  await fs.writeFile(mp4, header)
  const conn = fakeConn()
  await conn.sendFile(GROUP, mp4, 'ep.mp4', 'cap', undefined, false, { asDocument: true })
  const doc = conn.calls.find(c => c.data?.document)?.data
  assert.ok(doc, 'terkirim sebagai document')
  assert.equal(doc.fileName, 'ep.mp4')
  assert.equal(doc.mimetype, 'video/mp4')
  assert.ok(!('video' in doc))
  assert.ok(!('asDocument' in doc), 'opsi tidak bocor ke pesan WA')
  await conn.sendFile(GROUP, mp4, 'ep.mp4', 'cap')
  assert.ok(conn.calls.find(c => c.data?.video), 'default tetap video')
  await conn.store.close()
})
