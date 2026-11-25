// tests/profile.test.js — .profile (plugins/info/profile.js):
// SATU plugin utuh tanpa helper (spek founder 2026-11-25): nama dari DB
// (bukan pushName/getName manual), umur, level, EXP, limit, status
// premium, dan durasi premium HANYA bila premium aktif.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import handler from '../plugins/info/profile.js'

global.defaultLimit = 50
const NOW = 1764072000000

function fakeM(over = {}) {
  const replies = []
  return { replies, m: { pushName: 'Test', reply: async text => { replies.push(text); return text }, ...over } }
}
// Pasang DB palsu (global.db) selama satu tes, lalu kembalikan.
function withFakeDb(users, fn) {
  const prev = global.db
  global.db = { data: { users } }
  return Promise.resolve()
    .then(fn)
    .finally(() => { if (prev === undefined) delete global.db; else global.db = prev })
}
const TARGET_LID = '999000111222333@lid'
const TARGET_PN = '62899000111222@s.whatsapp.net'
function targetUser(patch = {}) {
  return { name: 'Banu', age: 20, registered: true, regTime: NOW - 30 * 86400_000, level: 2, exp: 40, limit: 12, premium: false, premiumTime: 0, ...patch }
}
function baseUser(patch = {}) {
  return { name: 'Veo', age: 20, registered: true, regTime: NOW - 30 * 86400_000, level: 5, exp: 120, limit: 37, premium: false, premiumTime: 0, ...patch }
}

test('command: .profile saja, bebas limit', () => {
  assert.equal(handler.command.test('profile'), true)
  assert.equal(handler.command.test('Profile'), true)
  assert.equal(handler.command.test('profil'), true)
  assert.equal(handler.command.test('Profil'), true)
  assert.equal(handler.command.test('profilex'), false)
  assert.equal(handler.limit, undefined, 'bebas limit — keputusan Veo 2026-11-25')
  assert.deepEqual(handler.tags, ['info'])
})

test('profile: menampilkan nama dari DB, umur, level, EXP, limit, status premium tanpa durasi', async () => {
  const { replies, m } = fakeM()
  await handler(m, { userData: baseUser() })
  const out = replies.join('\n')
  assert.match(out, /Profil Veo/)
  assert.match(out, /Nama: Veo/)
  assert.match(out, /Umur: 20 tahun/)
  assert.match(out, /Level: 5/)
  assert.match(out, /EXP: 120/)
  assert.match(out, /Limit: 37\/50/)
  assert.match(out, /Status Premium: Tidak aktif/)
  assert.doesNotMatch(out, /Durasi Premium/)
})

test('profile: nama diambil dari DB, bukan pushName', async () => {
  const { replies, m } = fakeM()
  await handler(m, { userData: baseUser({ name: '' }) })
  const out = replies.join('\n')
  assert.doesNotMatch(out, /Test/)
  assert.match(out, /Profil Unknown/)
  assert.match(out, /Nama: Unknown/)
})

test('profile: umur belum diisi bila age -1 (belum .register)', async () => {
  const { replies, m } = fakeM()
  await handler(m, { userData: baseUser({ age: -1, registered: false, regTime: -1 }) })
  assert.match(replies.join('\n'), /Umur: Belum diisi/)
})

test('profile: premium aktif menampilkan durasi lengkap sampai detik', async () => {
  const { replies, m } = fakeM()
  const realNow = Date.now
  Date.now = () => NOW
  try {
    const u = baseUser({ premium: true, premiumTime: NOW + 3 * 86400_000 + 4 * 3600_000 + 12 * 60_000 + 30_000 })
    await handler(m, { userData: u })
  } finally { Date.now = realNow }
  const out = replies.join('\n')
  assert.match(out, /Status Premium: Aktif/)
  assert.match(out, /Durasi Premium: 3 hari 4 jam 12 menit 30 detik/)
  assert.match(out, /Limit: Unlimited \(premium\)/)
})

test('profile: premium permanen menampilkan durasi Permanen', async () => {
  const { replies, m } = fakeM()
  await handler(m, { userData: baseUser({ premium: true, premiumTime: 0 }) })
  const out = replies.join('\n')
  assert.match(out, /Status Premium: Aktif/)
  assert.match(out, /Durasi Premium: Permanen/)
})

test('profile: premium kedaluwarsa dianggap tidak aktif, tanpa baris durasi', async () => {
  const { replies, m } = fakeM()
  await handler(m, { userData: baseUser({ premium: true, premiumTime: Date.now() - 1000 }) })
  const out = replies.join('\n')
  assert.match(out, /Status Premium: Tidak aktif/)
  assert.doesNotMatch(out, /Durasi Premium/)
})

test('profile: tidak memakai snapshot ctx premium — hitung sendiri dari userData', async () => {
  const { replies, m } = fakeM()
  const realNow = Date.now
  Date.now = () => NOW
  try {
    // Snapshot basi yang bilang tidak premium, padahal userData premium aktif.
    const u = baseUser({ premium: true, premiumTime: NOW + 90_000 })
    await handler(m, { userData: u, premium: { active: false, remainingMs: 0, remaining: 'tidak premium' } })
  } finally { Date.now = realNow }
  const out = replies.join('\n')
  assert.match(out, /Status Premium: Aktif/)
  assert.match(out, /Durasi Premium: 1 menit 30 detik/)
})

test('profile: reply pesan orang lain menampilkan profil target, bukan pengirim', async () => {
  await withFakeDb({ [TARGET_LID]: targetUser() }, async () => {
    const { replies, m } = fakeM({ quoted: { sender: TARGET_LID } })
    await handler(m, { userData: baseUser() })
    const out = replies.join('\n')
    assert.match(out, /Profil Banu/)
    assert.match(out, /Limit: 12\/50/)
    assert.doesNotMatch(out, /Profil Veo/)
  })
})

test('profile: tag @user menampilkan profil target', async () => {
  await withFakeDb({ [TARGET_LID]: targetUser() }, async () => {
    const { replies, m } = fakeM({ mentionedJid: [TARGET_LID] })
    await handler(m, { userData: baseUser() })
    assert.match(replies.join('\n'), /Profil Banu/)
  })
})

test('profile: nomor ketikan diurai via conn.identity lalu menampilkan profil target', async () => {
  const conn = { identity: {
    resolve: async input => input === '62899000111222' ? { lid: TARGET_LID, jid: TARGET_PN } : null,
    toJid: async () => null,
    toLid: async () => null,
    isBot: () => false,
  } }
  await withFakeDb({ [TARGET_LID]: targetUser() }, async () => {
    const { replies, m } = fakeM()
    await handler(m, { conn, userData: baseUser(), text: '62899000111222' })
    assert.match(replies.join('\n'), /Profil Banu/)
  })
})

test('profile: nomor ketikan tanpa conn.identity tetap ketemu via record kunci PN', async () => {
  await withFakeDb({ [TARGET_PN]: targetUser() }, async () => {
    const { replies, m } = fakeM()
    await handler(m, { userData: baseUser(), text: '62899000111222' })
    assert.match(replies.join('\n'), /Profil Banu/)
  })
})

test('profile: target reply dari kunci PN ketemu lewat bentuk LID-nya', async () => {
  const conn = { identity: {
    toJid: async key => key === TARGET_LID ? TARGET_PN : null,
    toLid: async key => key === TARGET_PN ? TARGET_LID : null,
    isBot: () => false,
  } }
  await withFakeDb({ [TARGET_PN]: targetUser() }, async () => {
    const { replies, m } = fakeM({ quoted: { sender: TARGET_LID } })
    await handler(m, { conn, userData: baseUser() })
    assert.match(replies.join('\n'), /Profil Banu/)
  })
})

test('profile: target tanpa record dilempar pesan tidak ditemukan (tanpa membuat record)', async () => {
  const users = {}
  await withFakeDb(users, async () => {
    const { m } = fakeM({ quoted: { sender: TARGET_LID } })
    await assert.rejects(handler(m, { userData: baseUser() }), /belum pernah memakai bot/)
    assert.deepEqual(users, {})
  })
})

test('profile: ketikan bukan nomor dilempar pesan target tidak dikenali', async () => {
  const { m } = fakeM()
  await assert.rejects(handler(m, { userData: baseUser(), text: 'namayangtidakada' }), /Target tidak dikenali/)
})
