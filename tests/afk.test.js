import test from 'node:test'
import assert from 'node:assert/strict'
import handler, { formatAfkDuration } from '../plugins/main/afk.js'

// Port legacy plugins/main-afk.js, main-afk_.js, main-brb.js.
// Diuji tanpa koneksi WhatsApp: fake m + ctx, record user di global.db
// palsu; forAction dipalsukan mengembalikan JID apa adanya.
function fakeM(over = {}) {
  const replies = []
  return {
    chat: '120363027117842341@g.us', sender: '111@lid', fromMe: false, text: '',
    mentionedJid: [], quoted: null, replies,
    reply: async (teks, _chatId, options = {}) => { replies.push({ teks: String(teks), mentions: options.mentions ?? [] }) },
    ...over,
  }
}

const fakeConn = { identity: { forAction: async ids => ids } }

function useFakeDb(t, users) {
  const db = { data: { users }, saves: 0, save: async () => { db.saves++ } }
  globalThis.db = db
  t.after(() => { delete globalThis.db })
  return db
}

const ctx = (over = {}) => ({ text: '', usedPrefix: '.', command: 'afk', conn: fakeConn, settings: {}, groupMetadata: null, ...over })

test('formatAfkDuration: jam-menit-detik ala legacy', () => {
  assert.equal(formatAfkDuration(0), '0j 0m 0d')
  assert.equal(formatAfkDuration(3661000), '1j 1m 1d')
  assert.equal(formatAfkDuration(90061000), '25j 1m 1d', 'jam terus bertambah, tanpa hari')
  assert.equal(formatAfkDuration(-5), '0j 0m 0d')
})

test('.afk: set status + alasan, balasan konfirmasi men-tag pengirim', async t => {
  const db = useFakeDb(t, { '111@lid': { afk: -1, afkReason: '' } })
  const m = fakeM()
  await handler(m, ctx({ text: 'lagi makan', userData: db.data.users['111@lid'] }))
  assert.ok(db.data.users['111@lid'].afk > 0)
  assert.equal(db.data.users['111@lid'].afkReason, 'lagi makan')
  assert.equal(db.saves, 1)
  assert.match(m.replies.at(-1).teks, /Status: _Afk_/)
  assert.match(m.replies.at(-1).teks, /lagi makan/)
  assert.match(m.replies.at(-1).teks, /@111/)
  assert.deepEqual(m.replies.at(-1).mentions, ['111@lid'])
})

test('.afk tanpa alasan: alasan bawaan "Tanpa Keterangan"', async t => {
  const db = useFakeDb(t, { '111@lid': { afk: -1, afkReason: '' } })
  const m = fakeM()
  await handler(m, ctx({ text: '', userData: db.data.users['111@lid'] }))
  assert.equal(db.data.users['111@lid'].afkReason, 'Tanpa Keterangan')
})

test('.brb command: alasan bawaan legacy "Gktau, kabur aja"', async t => {
  const db = useFakeDb(t, { '111@lid': { afk: -1, afkReason: '' } })
  await handler(fakeM(), ctx({ text: '', command: 'brb', userData: db.data.users['111@lid'] }))
  assert.equal(db.data.users['111@lid'].afkReason, 'Gktau, kabur aja')
})

test('before: "brb makan dulu" tanpa prefix mengeset AFK', async t => {
  const db = useFakeDb(t, { '111@lid': { afk: -1, afkReason: '' } })
  const m = fakeM({ text: 'brb makan dulu' })
  assert.equal(await handler.before(m, ctx({ userData: db.data.users['111@lid'] })), true)
  assert.ok(db.data.users['111@lid'].afk > 0)
  assert.equal(db.data.users['111@lid'].afkReason, 'makan dulu')
  assert.match(m.replies.at(-1).teks, /Status: _Afk_/)
})

test('before: "off" saja mengeset AFK dengan alasan bawaan', async t => {
  const db = useFakeDb(t, { '111@lid': { afk: -1, afkReason: '' } })
  const m = fakeM({ text: 'OFF' })
  assert.equal(await handler.before(m, ctx({ userData: db.data.users['111@lid'] })), true)
  assert.equal(db.data.users['111@lid'].afkReason, 'Gktau, kabur aja')
})

test('before: "brb" di tengah kalimat bukan trigger', async t => {
  const db = useFakeDb(t, { '111@lid': { afk: -1, afkReason: '' } })
  const m = fakeM({ text: 'aku brb bentar ya' })
  assert.equal(await handler.before(m, ctx({ userData: db.data.users['111@lid'] })), false)
  assert.equal(db.data.users['111@lid'].afk, -1)
  assert.deepEqual(m.replies, [])
})

test('before: pengirim pulang dari AFK diumumkan + status dihapus', async t => {
  const db = useFakeDb(t, { '111@lid': { afk: Date.now() - 3600000, afkReason: 'tidur' } })
  const m = fakeM({ text: 'halo semua' })
  assert.equal(await handler.before(m, ctx({ userData: db.data.users['111@lid'] })), false)
  assert.match(m.replies.at(-1).teks, /Udah balik dari AFK/)
  assert.match(m.replies.at(-1).teks, /tidur/)
  assert.match(m.replies.at(-1).teks, /1j 0m \d+d/)
  assert.equal(db.data.users['111@lid'].afk, -1)
  assert.equal(db.data.users['111@lid'].afkReason, '')
})

test('before: pulang tanpa alasan tersimpan memakai "Gatau, kabur aja"', async t => {
  const db = useFakeDb(t, { '111@lid': { afk: Date.now() - 61000, afkReason: '' } })
  const m = fakeM({ text: 'balik' })
  await handler.before(m, ctx({ userData: db.data.users['111@lid'] }))
  assert.match(m.replies.at(-1).teks, /Gatau, kabur aja/)
})

test('before: .afk ulang saat sudah AFK tidak mengumumkan pulang', async t => {
  const db = useFakeDb(t, { '111@lid': { afk: Date.now() - 60000, afkReason: 'lama' } })
  const m = fakeM({ text: '.afk alasan baru' })
  assert.equal(await handler.before(m, ctx({ userData: db.data.users['111@lid'] })), false)
  assert.deepEqual(m.replies, [], 'command yang mengeset ulang yang menjawab')
  assert.ok(db.data.users['111@lid'].afk > 0, 'status lama belum dihapus hook')
})

test('before: mention orang AFK dibalas pemberitahuan + durasi', async t => {
  const db = useFakeDb(t, {
    '111@lid': { afk: -1, afkReason: '' },
    '222@lid': { afk: Date.now() - 61000, afkReason: 'makan' },
    '333@lid': { afk: -1, afkReason: '' },
  })
  const m = fakeM({ text: 'woi', mentionedJid: ['222@lid', '333@lid'] })
  assert.equal(await handler.before(m, ctx({ userData: db.data.users['111@lid'] })), false)
  assert.equal(m.replies.length, 1, 'hanya yang AFK diberitahukan')
  assert.match(m.replies[0].teks, /jangan ganggu/)
  assert.match(m.replies[0].teks, /"makan"/)
  assert.match(m.replies[0].teks, /0j 1m \d+d/)
  assert.match(m.replies[0].teks, /@222/)
  assert.deepEqual([...m.replies[0].mentions].sort(), ['111@lid', '222@lid'])
})

test('before: reply ke pesan orang AFK juga diberitahukan', async t => {
  const db = useFakeDb(t, {
    '111@lid': { afk: -1, afkReason: '' },
    '222@lid': { afk: Date.now() - 5000, afkReason: '' },
  })
  const m = fakeM({ text: 'ini maksudnya apa?', quoted: { sender: '222@lid' } })
  await handler.before(m, ctx({ userData: db.data.users['111@lid'] }))
  assert.equal(m.replies.length, 1)
  assert.match(m.replies[0].teks, /tanpa alasan, misterius banget/)
})

test('before: mention diri sendiri dan orang tak dikenal dilewati', async t => {
  const db = useFakeDb(t, { '111@lid': { afk: -1, afkReason: '' } })
  const m = fakeM({ text: 'hai', mentionedJid: ['111@lid', '999@lid'] })
  await handler.before(m, ctx({ userData: db.data.users['111@lid'] }))
  assert.deepEqual(m.replies, [])
})

test('before: pesan bot sendiri dan teks kosong dilewati', async t => {
  const db = useFakeDb(t, { '111@lid': { afk: Date.now() - 1000, afkReason: 'x' } })
  const m1 = fakeM({ text: 'balik', fromMe: true })
  assert.equal(await handler.before(m1, ctx({ userData: db.data.users['111@lid'] })), false)
  assert.deepEqual(m1.replies, [])
  assert.ok(db.data.users['111@lid'].afk > 0, 'pesan bot tidak menghapus AFK')
  const m2 = fakeM({ text: '   ' })
  assert.equal(await handler.before(m2, ctx({ userData: { afk: -1, afkReason: '' } })), false)
})

test('afk: metadata plugin — tag main, tiga perintah', () => {
  assert.deepEqual(handler.tags, ['main'])
  assert.ok(handler.command.test('afk') && handler.command.test('brb') && handler.command.test('off'))
  assert.ok(!handler.command.test('afkk') && !handler.command.test('a'))
  assert.deepEqual(handler.help, ['afk [alasan]', 'brb [alasan]', 'off [alasan]'])
})
