import { test } from 'node:test'
import assert from 'node:assert/strict'
import handler from '../plugins/tools/qrcode.js'

// Port tool-qrcode.js legacy: teks -> data URL PNG (package `qrcode`)
// -> conn.sendFile sebagai qrcode.png. Diuji pakai conn palsu yang
// merekam panggilan sendFile; tidak ada koneksi WhatsApp yang dibuka.
const buatConnPalsu = () => {
  const calls = []
  return { calls, conn: { sendFile: async (...args) => { calls.push(args) } } }
}
const m = { chat: '123@g.us', key: { remoteJid: '123@g.us', id: 'm1' } }
const ctx = (conn, text) => ({ conn, text, usedPrefix: '.', command: 'qrcode' })

test('qrcode: tanpa teks melempar contoh penggunaan', async () => {
  const { calls, conn } = buatConnPalsu()
  await assert.rejects(
    () => handler(m, ctx(conn, '')),
    e => typeof e === 'string' && /Contoh penggunaan:\n\.qrcode google\.com/.test(e))
  assert.equal(calls.length, 0)
})

test('qrcode: teks dikirim sebagai PNG data URL bernama qrcode.png', async () => {
  const { calls, conn } = buatConnPalsu()
  await handler(m, ctx(conn, 'Clara Aubert'))
  assert.equal(calls.length, 1)
  const [jid, url, filename, caption, quoted] = calls[0]
  assert.equal(jid, m.chat)
  assert.ok(typeof url === 'string' && url.startsWith('data:image/png;base64,iVBOR'), 'data URL PNG')
  assert.equal(filename, 'qrcode.png')
  assert.equal(caption, 'Nih.')
  assert.equal(quoted, m)
})

test('qrcode: teks 5000 karakter tetap terkirim (payload dipotong 2048)', async () => {
  const { calls, conn } = buatConnPalsu()
  await handler(m, ctx(conn, 'a'.repeat(5000)))
  assert.equal(calls.length, 1)
})

test('qrcode: metadata plugin — sharing, tag tools, perintah qr/qrcode', () => {
  assert.equal(handler.sharing, true)
  assert.equal(handler.register, undefined, 'flag register per-plugin sudah dicabut; gerbang registrasi kini bawaan pipeline')
  assert.deepEqual(handler.tags, ['tools'])
  assert.ok(handler.command.test('qr') && handler.command.test('qrcode'))
})

test('qrcode: payload melewati kapasitas QR jadi pesan Maks 2048 karakter', async () => {
  const { calls, conn } = buatConnPalsu()
  // '€' = 3 byte UTF-8; 2048 karakter = 6144 byte, jauh di atas
  // kapasitas byte QR — toDataURL melempar, plugin menggantinya
  // dengan pesan yang jelas.
  await assert.rejects(
    () => handler(m, ctx(conn, '€'.repeat(2048))),
    e => e === 'Maks 2048 karakter.')
  assert.equal(calls.length, 0)
})
