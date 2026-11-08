import { test } from 'node:test'
import assert from 'node:assert/strict'
import handler from '../plugins/owner/kirim.js'

// Port owner-kirim.js legacy versi sederhana (perintah pemilik:
// cukup conn.reply). Diuji pakai conn palsu yang merekam panggilan
// reply; tidak ada koneksi WhatsApp yang dibuka.
const buatConnPalsu = () => {
  const calls = []
  return { calls, conn: { reply: async (...args) => { calls.push(args) } } }
}
const m = { chat: '123@g.us', sender: '6282348181097@s.whatsapp.net', key: { remoteJid: '123@g.us', id: 'm1' } }

test('kirim: teks digemakan lewat conn.reply ke chat asal, mengutip perintah', async () => {
  const { calls, conn } = buatConnPalsu()
  await handler(m, { conn, text: 'halo semua' })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [m.chat, 'halo semua', m])
})

test('kirim: tanpa teks memakai bawaan legacy "Sailox berkata"', async () => {
  const { calls, conn } = buatConnPalsu()
  await handler(m, { conn, text: '' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], 'Sailox berkata')
  const { calls: calls2, conn: conn2 } = buatConnPalsu()
  await handler(m, { conn: conn2, text: '   ' })
  assert.equal(calls2[0][1], 'Sailox berkata', 'teks hanya spasi dianggap kosong')
})

test('kirim: metadata plugin — owner, tag owner, perintah k/kirim', () => {
  assert.equal(handler.owner, true)
  assert.deepEqual(handler.tags, ['owner'])
  assert.ok(handler.command.test('k') && handler.command.test('kirim'))
  assert.ok(!handler.command.test('kirimx') && !handler.command.test('kirimlottie'))
})
