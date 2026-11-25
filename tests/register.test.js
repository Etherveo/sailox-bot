// tests/register.test.js — .register (plugins/main/register.js):
// nama diisi HANYA saat registrasi, menimpa nama lama bila ada (meski
// belum terdaftar), dan registrasi hanya bisa dilakukan sekali.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import handler from '../plugins/main/register.js'

const SENDER = '10001@lid'
function fakeDb(users) {
  return {
    ensure: (name, key) => {
      if (!users[key]) users[key] = { name: '', registered: false, regTime: -1, age: -1 }
      return users[key]
    },
    save: async () => {},
  }
}
function fakeM() {
  const replies = []
  return { replies, m: { sender: SENDER, reply: async text => { replies.push(text); return text } } }
}
// Pasang DB palsu (global.db) selama satu tes, lalu kembalikan.
function withFakeDb(users, fn) {
  const prev = global.db
  global.db = fakeDb(users)
  return Promise.resolve()
    .then(fn)
    .finally(() => { if (prev === undefined) delete global.db; else global.db = prev })
}

test('command: .register / .daftar saja', () => {
  assert.equal(handler.command.test('register'), true)
  assert.equal(handler.command.test('daftar'), true)
  assert.equal(handler.command.test('registerx'), false)
  assert.equal(handler.register, false)
})

test('register: nama lama yang sudah terisi (belum terdaftar) ditimpa nama registrasi', async () => {
  const users = { [SENDER]: { name: 'NamaLama', registered: false, regTime: -1, age: -1 } }
  await withFakeDb(users, async () => {
    const { replies, m } = fakeM()
    await handler(m, { text: 'Banu.20' })
    assert.equal(users[SENDER].name, 'Banu')
    assert.equal(users[SENDER].age, 20)
    assert.equal(users[SENDER].registered, true)
    assert.ok(users[SENDER].regTime > 0)
    assert.match(replies.join('\n'), /Pendaftaran berhasil/)
  })
})

test('register: user baru tanpa nama lama terdaftar dengan nama itu', async () => {
  const users = {}
  await withFakeDb(users, async () => {
    const { m } = fakeM()
    await handler(m, { text: 'Veo.25' })
    assert.equal(users[SENDER].name, 'Veo')
    assert.equal(users[SENDER].registered, true)
  })
})

test('register: hanya sekali — percobaan kedua ditolak dan nama tidak berubah', async () => {
  const users = { [SENDER]: { name: 'Banu', registered: true, regTime: 1000, age: 20 } }
  await withFakeDb(users, async () => {
    const { m } = fakeM()
    await assert.rejects(handler(m, { text: 'Lain.30' }), /sudah terdaftar/)
    assert.equal(users[SENDER].name, 'Banu')
    assert.equal(users[SENDER].age, 20)
  })
})

test('register: format salah ditolak', async () => {
  const users = {}
  await withFakeDb(users, async () => {
    const { m } = fakeM()
    await assert.rejects(handler(m, { text: 'Banu' }), /Gunakan \.register Nama\.20/)
    await assert.rejects(handler(m, { text: 'Banu.0' }), /Gunakan \.register Nama\.20/)
    await assert.rejects(handler(m, { text: 'Banu.121' }), /Gunakan \.register Nama\.20/)
    assert.equal(users[SENDER]?.registered ?? false, false)
  })
})
