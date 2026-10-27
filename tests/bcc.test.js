// tests/bcc.test.js — .bcc broadcast ke saluran: komposisi teks,
// sesi tanya konflik (pilih angka tanpa reply), urutan gabung, dan
// pengiriman gambar + caption (termasuk split caption >1024).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBccSessionStore, decideBcc, combineBccTexts, previewBcc, resolveBccTarget, BCC_SESSION_TTL_MS } from '../lib/helpers/bccSession.js'
import { coerceConfigValue } from '../lib/helpers/configStore.js'
import bccHandler from '../plugins/owner/bcc.js'

const CHANNEL = '120363111222333@newsletter'

function fakeConn() {
  const calls = []
  return { calls, sendMessage: async (jid, content) => { calls.push({ jid, content }); return { key: { id: 'sent1' } } } }
}
function fakeMsg(over = {}) {
  const replies = []
  const m = {
    chat: '120363999@g.us', sender: '62823@s.whatsapp.net', text: '', mtype: 'conversation',
    fromMe: false, key: { remoteJid: '120363999@g.us', id: 'msg1' },
    reply: async t => { replies.push(String(t)) },
    ...over,
  }
  m.replies = replies
  return m
}
const mediaSends = conn => conn.calls.filter(c => c.content.image !== undefined || c.content.text !== undefined)
function withChannel(t, value) {
  const saved = globalThis.botChannel
  t.after(() => { if (saved === undefined) delete globalThis.botChannel; else globalThis.botChannel = saved })
  if (value === undefined) delete globalThis.botChannel; else globalThis.botChannel = value
}

// ─── Logika murni ───────────────────────────────────────────────────────────

test('bcc: decideBcc membedakan direct / reply / konflik / kosong', () => {
  assert.equal(decideBcc({ directText: 'hai', replyText: '' }).kind, 'direct')
  assert.equal(decideBcc({ directText: '', replyText: 'cap' }).kind, 'reply')
  assert.equal(decideBcc({ directText: 'hai', replyText: 'cap' }).kind, 'conflict')
  assert.equal(decideBcc({ directText: '  ', replyText: '' }).kind, 'empty')
  assert.equal(decideBcc({}).kind, 'empty')
})

test('bcc: combineBccTexts dua urutan, sumber kosong dilewati', () => {
  assert.equal(combineBccTexts('direct', 'reply', 'direct-first'), 'direct\nreply')
  assert.equal(combineBccTexts('direct', 'reply', 'reply-first'), 'reply\ndirect')
  assert.equal(combineBccTexts('', 'reply', 'direct-first'), 'reply')
})

test('bcc: previewBcc satu baris + potong 200 karakter', () => {
  assert.equal(previewBcc('a\nb  c'), 'a b c')
  assert.equal(previewBcc('x'.repeat(300)).length, 200)
  assert.ok(previewBcc('x'.repeat(300)).endsWith('…'))
})

test('bcc: resolveBccTarget hanya menerima JID @newsletter', () => {
  assert.equal(resolveBccTarget('120363111@newsletter'), '120363111@newsletter')
  assert.equal(resolveBccTarget('120363111@g.us'), null)
  assert.equal(resolveBccTarget('https://whatsapp.com/channel/abc'), null)
  assert.equal(resolveBccTarget(''), null)
  assert.equal(resolveBccTarget(undefined), null)
})

test('bcc: store put/get, kedaluwarsa malas, touch, delete', () => {
  let nowVal = 1000
  const store = createBccSessionStore({ ttlMs: 1000, now: () => nowVal })
  store.put('c', 'A', { step: 'choose', directText: 'd', replyText: 'r', media: null })
  assert.equal(store.get('c', 'A')?.step, 'choose')
  assert.equal(store.get('c', 'B'), null, 'sender lain tidak ikut')
  nowVal = 1500
  store.touch('c', 'A')
  nowVal = 2000
  assert.ok(store.get('c', 'A'), 'touch memperpanjang TTL')
  nowVal = 3000
  assert.equal(store.get('c', 'A'), null, 'kedaluwarsa malas')
  store.put('c', 'A', { step: 'choose' })
  store.delete('c', 'A')
  assert.equal(store.get('c', 'A'), null)
  assert.ok(BCC_SESSION_TTL_MS >= 60 * 1000, 'TTL sesi minimal 1 menit')
})

test('bcc: config botChannel tipe newsletter divalidasi .config', () => {
  assert.equal(coerceConfigValue('botChannel', '120363111@newsletter'), '120363111@newsletter')
  assert.throws(() => coerceConfigValue('botChannel', '120363111@g.us'), /newsletter/)
  assert.throws(() => coerceConfigValue('botChannel', 'link-channel'), /newsletter/)
})

// ─── Handler ────────────────────────────────────────────────────────────────

test('bcc: terdaftar founder-only sebagai bcc/broadcastchannel', () => {
  assert.equal(bccHandler.founder, true)
  assert.deepEqual(bccHandler.command, ['bcc', 'broadcastchannel'])
})

test('bcc: teks direct saja langsung disiarkan tanpa sesi', async t => {
  withChannel(t, CHANNEL)
  const conn = fakeConn()
  const m = fakeMsg()
  await bccHandler(m, { conn, text: 'halo saluran', bccSessions: createBccSessionStore() })
  const sends = mediaSends(conn)
  assert.equal(sends.length, 1)
  assert.equal(sends[0].jid, CHANNEL)
  assert.equal(sends[0].content.text, 'halo saluran')
  assert.ok(m.replies.some(r => r.includes('Broadcast terkirim')))
  assert.ok(conn.calls.some(c => c.content.react?.text === '✅'), 'react ✅ ditempel')
})

test('bcc: tanpa botChannel ditolak jelas, tidak disiarkan', async t => {
  withChannel(t, undefined)
  const conn = fakeConn()
  await assert.rejects(bccHandler(fakeMsg(), { conn, text: 'hai', bccSessions: createBccSessionStore() }), /botChannel/)
  assert.equal(mediaSends(conn).length, 0)
})

test('bcc: tanpa teks dan tanpa media ditolak dengan usage', async t => {
  withChannel(t, CHANNEL)
  const conn = fakeConn()
  await assert.rejects(bccHandler(fakeMsg(), { conn, text: '', bccSessions: createBccSessionStore() }), /Kirim pesannya/)
})

test('bcc: gambar sendiri tanpa teks disiarkan tanpa caption', async t => {
  withChannel(t, CHANNEL)
  const conn = fakeConn()
  const m = fakeMsg({ mtype: 'imageMessage', msg: { mimetype: 'image/png' }, download: async () => Buffer.from('FAKEIMG') })
  await bccHandler(m, { conn, text: '', bccSessions: createBccSessionStore() })
  const sends = mediaSends(conn)
  assert.equal(sends.length, 1)
  assert.ok(Buffer.isBuffer(sends[0].content.image))
  assert.equal(sends[0].content.caption, '')
})

test('bcc: konflik -> sesi tanya, pilih 3 lalu 2 = gabung reply di atas', async t => {
  withChannel(t, CHANNEL)
  const conn = fakeConn()
  const store = createBccSessionStore()
  const m = fakeMsg({
    quoted: { mtype: 'imageMessage', caption: 'caption lama', msg: { mimetype: 'image/jpeg' }, download: async () => Buffer.from('FAKEIMG') },
  })
  await bccHandler(m, { conn, text: 'hai', bccSessions: store })
  assert.equal(mediaSends(conn).length, 0, 'belum ada yang disiarkan saat konflik')
  assert.ok(m.replies.some(r => r.includes('1. Direct text') && r.includes('3. Gabung')), 'prompt pilihan terkirim')
  assert.equal(store.get(m.chat, m.sender)?.step, 'choose')

  const pick3 = fakeMsg({ text: '3' })
  assert.equal(await bccHandler.before(pick3, { conn, bccSessions: store }), true)
  assert.equal(store.get(m.chat, m.sender)?.step, 'order')
  assert.ok(pick3.replies.some(r => r.includes('Direct di atas') && r.includes('Reply di atas')))

  const pick2 = fakeMsg({ text: '2' })
  assert.equal(await bccHandler.before(pick2, { conn, bccSessions: store }), true)
  const sends = mediaSends(conn)
  assert.equal(sends.length, 1)
  assert.equal(sends[0].jid, CHANNEL)
  assert.ok(Buffer.isBuffer(sends[0].content.image))
  assert.equal(sends[0].content.caption, 'caption lama\nhai', 'urutan 2 = reply di atas, direct di bawah')
  assert.equal(store.get(m.chat, m.sender), null, 'sesi ditutup setelah siaran')
  assert.ok(pick2.replies.some(r => r.includes('Broadcast terkirim')))
})

test('bcc: konflik pilih 1 = direct saja, pilih batal menutup sesi', async t => {
  withChannel(t, CHANNEL)
  const conn = fakeConn()
  const store = createBccSessionStore()
  const m = fakeMsg({ quoted: { mtype: 'conversation', text: 'teks reply' } })
  await bccHandler(m, { conn, text: 'teks direct', bccSessions: store })
  assert.equal(store.get(m.chat, m.sender)?.step, 'choose')

  const pick1 = fakeMsg({ text: '1' })
  await bccHandler.before(pick1, { conn, bccSessions: store })
  const sends = mediaSends(conn)
  assert.equal(sends.length, 1)
  assert.equal(sends[0].content.text, 'teks direct')

  // Sesi baru lalu batal
  await bccHandler(m, { conn, text: 'lagi', bccSessions: store })
  const cancel = fakeMsg({ text: 'batal' })
  assert.equal(await bccHandler.before(cancel, { conn, bccSessions: store }), true)
  assert.equal(store.get(m.chat, m.sender), null)
  assert.ok(cancel.replies.some(r => r.includes('ditutup')))
})

test('bcc: hook dilewati tanpa sesi, dan angka di luar rentang diingatkan', async t => {
  withChannel(t, CHANNEL)
  const conn = fakeConn()
  const store = createBccSessionStore()
  assert.equal(await bccHandler.before(fakeMsg({ text: '1' }), { conn, bccSessions: store }), false)
  store.put('120363999@g.us', '62823@s.whatsapp.net', { step: 'choose', directText: 'd', replyText: 'r', media: null })
  const out = fakeMsg({ text: '9' })
  assert.equal(await bccHandler.before(out, { conn, bccSessions: store }), true)
  assert.ok(out.replies.some(r => r.includes('1–3')))
  assert.equal(mediaSends(conn).length, 0, 'angka liar tidak menyiarkan')
  const other = fakeMsg({ text: '.menu' })
  assert.equal(await bccHandler.before(other, { conn, bccSessions: store }), false, 'perintah lain dibiarkan lewat')
})

test('bcc: caption >1024 dikirim sebagai gambar polos + pesan teks', async t => {
  withChannel(t, CHANNEL)
  const conn = fakeConn()
  const m = fakeMsg({ mtype: 'imageMessage', msg: { mimetype: 'image/jpeg' }, download: async () => Buffer.from('FAKEIMG') })
  const long = 'x'.repeat(2000)
  await bccHandler(m, { conn, text: long, bccSessions: createBccSessionStore() })
  const sends = mediaSends(conn)
  assert.equal(sends.length, 2)
  assert.ok(Buffer.isBuffer(sends[0].content.image))
  assert.equal(sends[0].content.caption, undefined, 'gambar tanpa caption')
  assert.equal(sends[1].content.text, long, 'teks penuh menyusul terpisah')
})
