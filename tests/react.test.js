import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REACT, assertEmoji, reactionKey, sendReaction, reactTo, reactProcessing } from '../lib/helpers/react.js'

function fakeConn() {
  const calls = []
  return { calls, sendMessage: async (jid, content) => { calls.push({ jid, content }); return { key: { id: 'srv' } } } }
}

test('react: reactionKey menurunkan key dari pesan dan menolak key tidak lengkap', () => {
  assert.deepEqual(
    reactionKey({ key: { remoteJid: '628@s.whatsapp.net', fromMe: false, id: 'M1' } }),
    { remoteJid: '628@s.whatsapp.net', fromMe: false, id: 'M1' },
  )
  const group = reactionKey({ key: { remoteJid: '123@g.us', fromMe: false, id: 'M2', participant: '628@s.whatsapp.net' } })
  assert.equal(group.participant, '628@s.whatsapp.net')
  assert.throws(() => reactionKey({ key: { remoteJid: 'x@s.whatsapp.net' } }), /key lengkap/)
  assert.throws(() => reactionKey(null), /key lengkap/)
  assert.throws(() => reactionKey({}), /key lengkap/)
})

test('react: assertEmoji menolak kosong dan yang kepanjangan', () => {
  assert.equal(assertEmoji(' ⏳ '), '⏳')
  assert.throws(() => assertEmoji(''), /wajib diisi/)
  assert.throws(() => assertEmoji('   '), /wajib diisi/)
  assert.throws(() => assertEmoji(null), /wajib diisi/)
  assert.throws(() => assertEmoji('x'.repeat(17)), /terlalu panjang/)
})

test('react: reactTo menempel pada remoteJid key pesan itu sendiri', async () => {
  const conn = fakeConn()
  const m = { key: { remoteJid: '777@lid', fromMe: false, id: 'ABC' }, conn }
  await reactTo(m, REACT.processing)
  assert.equal(conn.calls.length, 1)
  assert.equal(conn.calls[0].jid, '777@lid')
  assert.deepEqual(conn.calls[0].content, { react: { text: '⏳', key: { remoteJid: '777@lid', fromMe: false, id: 'ABC' } } })
  await reactProcessing(m)
  assert.equal(conn.calls[1].content.react.text, '⏳')
})

test('react: sendReaction menolak key tidak lengkap dan koneksi hilang', async () => {
  const conn = fakeConn()
  await assert.rejects(sendReaction(conn, { remoteJid: 'x@s.whatsapp.net' }, '👍'), /tidak lengkap/)
  await assert.rejects(sendReaction(null, { remoteJid: 'x@s.whatsapp.net', id: 'M' }, '👍'), /tidak tersedia/)
  await assert.rejects(reactTo({ key: { remoteJid: 'x@s.whatsapp.net', id: 'M' } }, '👍'), /tidak tersedia/)
})
