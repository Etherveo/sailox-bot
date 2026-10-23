import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTargets, findParticipant } from '../lib/helpers/groupTargets.js'
import addHandler from '../plugins/group/add.js'
import kickHandler from '../plugins/group/kick.js'
import promoteHandler from '../plugins/group/promote.js'
import demoteHandler from '../plugins/group/demote.js'
import nHandler from '../plugins/info/n.js'
import ukurHandler from '../plugins/tools/ukur.js'
import setnamaHandler from '../plugins/group/setnamagrup.js'
import setdescHandler from '../plugins/group/setdesc.js'
import bukatutupHandler from '../plugins/group/bukatutup.js'
import linkgcHandler from '../plugins/group/linkgc.js'

// Fixture peserta grup berformat LID (engine LID-first): id & lid bentuk
// LID, phoneNumber bentuk PN — satu orang, tiga bentuk identitas.
const ALT = { id: '555000111222@lid', lid: '555000111222@lid', phoneNumber: '6289528749986@s.whatsapp.net', admin: null }
const ADMIN = { id: '999888777666@lid', lid: '999888777666@lid', phoneNumber: '628111222333@s.whatsapp.net', admin: 'admin' }
const CREATOR = { id: '777666555444@lid', lid: '777666555444@lid', phoneNumber: '628444555666@s.whatsapp.net', admin: 'superadmin' }
const PARTICIPANTS = [ALT, ADMIN, CREATOR]

function fakeConn(statusByAction = {}) {
  const calls = [], replies = [], sent = []
  const conn = {
    calls, replies, sent,
    toJid: async id => (String(id).endsWith('@lid') ? null : String(id)),
    identity: {
      isBot: () => false,
      roleOf: () => ({ isOwner: false, isFounder: false }),
      toJid: async id => (String(id).endsWith('@lid') ? null : String(id)),
      resolve: async () => ({ jid: '6289528749986@s.whatsapp.net', lid: '555000111222@lid' }),
    },
    getName: async () => 'Veo Cadangan',
    groupParticipantsUpdate: async (chat, ids, action) => { calls.push({ chat, ids, action }); return [{ status: statusByAction[action] ?? '200', jid: ids[0] }] },
    groupInviteCode: async () => 'KODEUNDANGAN123',
    groupUpdateSubject: async (chat, subject) => { calls.push({ action: 'subject', subject }) },
    groupUpdateDescription: async (chat, desc) => { calls.push({ action: 'desc', desc }) },
    groupSettingUpdate: async (chat, setting) => { calls.push({ action: 'setting', setting }) },
    sendMessage: async (jid, content) => { sent.push({ jid, content }) },
    reply: async (chat, text, m, opts) => { replies.push(String(text)) },
  }
  return conn
}

const baseM = (over = {}) => ({ chat: '123456@g.us', sender: '6282348181097@s.whatsapp.net', mentionedJid: [], quoted: null, reply: async function (t) { this.__replies = [...(this.__replies ?? []), String(t)] }, ...over })
const baseCtx = (conn, over = {}) => ({ conn, text: '', participants: PARTICIPANTS, groupMetadata: { subject: 'Velaryna' }, usedPrefix: '.', command: 'add', ...over })

test('parseTargets: gabungan mention, reply, dan nomor bebas — unik & ternormalisasi', () => {
  const targets = parseTargets({ mentionedJid: ['555000111222@lid'], quotedSender: '999888777666@lid', text: 'tolong 089528749986 dan +62 812-3456-789' })
  assert.deepEqual(targets.map(t => t.digits), ['555000111222', '999888777666', '6289528749986', '628123456789'])
  assert.equal(parseTargets({ text: 'bukan nomor sama sekali' }).length, 0)
  assert.equal(parseTargets({}).length, 0)
})

test('findParticipant: ketemu dari bentuk PN, LID, maupun phoneNumber', () => {
  assert.equal(findParticipant(PARTICIPANTS, '6289528749986@s.whatsapp.net')?.id, ALT.id)
  assert.equal(findParticipant(PARTICIPANTS, '555000111222@lid')?.id, ALT.id)
  assert.equal(findParticipant(PARTICIPANTS, { id: '628111222333@s.whatsapp.net' })?.id, ADMIN.id)
  assert.equal(findParticipant(PARTICIPANTS, '628123456789@s.whatsapp.net'), null)
})

test('add: member yang sudah ada ditolak (anti tambah ganda), non-member ditambahkan', async () => {
  const conn = fakeConn()
  await addHandler(baseM(), baseCtx(conn, { text: '6289528749986' }))
  assert.equal(conn.calls.length, 0, 'tidak ada panggilan add untuk member lama')
  assert.match(conn.replies[0], /sudah ada di grup, tidak ditambah dua kali/)
  const conn2 = fakeConn()
  await addHandler(baseM(), baseCtx(conn2, { text: '628123456789' }))
  assert.equal(conn2.calls[0].action, 'add')
  assert.match(conn2.replies[0], /berhasil ditambahkan/)
})

test('add: status privasi 403 memicu undangan DM berisi link grup', async () => {
  const conn = fakeConn({ add: '403' })
  await addHandler(baseM(), baseCtx(conn, { text: '628123456789' }))
  assert.equal(conn.sent.length, 1)
  assert.match(conn.sent[0].content.text, /chat\.whatsapp\.com\/KODEUNDANGAN123/)
  assert.match(conn.replies[0], /undangan dikirim ke DM/)
})

test('promote: member jadi admin; yang sudah admin & bukan member ditolak', async () => {
  const conn = fakeConn()
  await promoteHandler(baseM(), baseCtx(conn, { text: '6289528749986', command: 'promote' }))
  assert.equal(conn.calls[0].action, 'promote')
  assert.match(conn.replies[0], /sekarang jadi admin/)
  const conn2 = fakeConn()
  await promoteHandler(baseM(), baseCtx(conn2, { text: '628111222333', command: 'promote' }))
  assert.equal(conn2.calls.length, 0)
  assert.match(conn2.replies[0], /sudah admin, tidak di-promote dua kali/)
  const conn3 = fakeConn()
  await promoteHandler(baseM(), baseCtx(conn3, { text: '628123456789', command: 'promote' }))
  assert.equal(conn3.calls.length, 0)
  assert.match(conn3.replies[0], /bukan member grup ini/)
})

test('demote: admin turun; member biasa & pembuat grup ditolak', async () => {
  const conn = fakeConn()
  await demoteHandler(baseM(), baseCtx(conn, { text: '628111222333', command: 'demote' }))
  assert.equal(conn.calls[0].action, 'demote')
  assert.match(conn.replies[0], /sekarang member biasa/)
  const conn2 = fakeConn()
  await demoteHandler(baseM(), baseCtx(conn2, { text: '6289528749986', command: 'demote' }))
  assert.equal(conn2.calls.length, 0)
  assert.match(conn2.replies[0], /memang member biasa/)
  const conn3 = fakeConn()
  await demoteHandler(baseM({ mentionedJid: [CREATOR.id] }), baseCtx(conn3, { command: 'demote' }))
  assert.equal(conn3.calls.length, 0)
  assert.match(conn3.replies[0], /pembuat grup/)
})

test('kick: member dikeluarkan; bukan member & pembuat grup ditolak', async () => {
  const conn = fakeConn()
  await kickHandler(baseM(), baseCtx(conn, { text: '6289528749986', command: 'kick' }))
  assert.equal(conn.calls[0].action, 'remove')
  assert.match(conn.replies[0], /berhasil dikeluarkan/)
  const conn2 = fakeConn()
  await kickHandler(baseM(), baseCtx(conn2, { text: '628123456789', command: 'kick' }))
  assert.equal(conn2.calls.length, 0)
  assert.match(conn2.replies[0], /bukan member grup ini/)
  const conn3 = fakeConn()
  await kickHandler(baseM({ mentionedJid: [CREATOR.id] }), baseCtx(conn3, { command: 'kick' }))
  assert.equal(conn3.calls.length, 0)
  assert.match(conn3.replies[0], /pembuat grup/)
})

test('.n: menampilkan nomor telepon asli (PN), bukan angka LID', async () => {
  const conn = fakeConn()
  const m = baseM({ mentionedJid: ['555000111222@lid'] })
  await nHandler(m, { conn, text: '', participants: PARTICIPANTS })
  const out = m.__replies[0]
  assert.match(out, /\+6289528749986/)
  assert.match(out, /wa\.me\/6289528749986/)
  assert.match(out, /LID:\* 555000111222/)
})

test('.n: identitas LID-only dilaporkan jujur sebagai belum diketahui', async () => {
  const conn = fakeConn()
  conn.identity.resolve = async () => ({ jid: null, lid: '555000111222@lid' })
  const m = baseM()
  await nHandler(m, { conn, text: '', participants: [] })
  assert.match(m.__replies[0], /belum diketahui bot/)
})

test('.ukur: statistik legacy, emoji terhitung satu karakter', async () => {
  const m = baseM()
  await ukurHandler(m, { text: 'halo dunia', usedPrefix: '.', command: 'ukur' })
  assert.match(m.__replies[0], /Karakter: 10/)
  assert.match(m.__replies[0], /Kata: 2/)
  const m2 = baseM()
  await ukurHandler(m2, { text: 'a🎉b', usedPrefix: '.', command: 'ukur' })
  assert.match(m2.__replies[0], /Karakter: 3/)
})

test('setnamagrup: batas 100 karakter ditegakkan, emoji aman', async () => {
  const conn = fakeConn()
  await assert.rejects(() => setnamaHandler(baseM(), baseCtx(conn, { text: 'x'.repeat(101), command: 'setnamagrup' })), /maksimal 100 karakter/)
  const m = baseM()
  await setnamaHandler(m, baseCtx(conn, { text: 'Velaryna 🎉 Baru', command: 'setnamagrup' }))
  assert.equal(conn.calls[0].subject, 'Velaryna 🎉 Baru')
  assert.match(m.__replies[0], /Nama grup diganti/)
})

test('setdesc: teks kosong ditolak, teks valid dipasang', async () => {
  const conn = fakeConn()
  await assert.rejects(() => setdescHandler(baseM(), baseCtx(conn, { text: '  ', command: 'setdesc' })), /Deskripsinya apa/)
  const m = baseM()
  await setdescHandler(m, baseCtx(conn, { text: 'Grup santai, no spam.', command: 'setdesc' }))
  assert.equal(conn.calls[0].desc, 'Grup santai, no spam.')
})

test('setdesc: batas 2048 karakter (termasuk spasi) ditegakkan', async () => {
  const conn = fakeConn()
  await assert.rejects(() => setdescHandler(baseM(), baseCtx(conn, { text: 'a'.repeat(2049), command: 'setdesc' })), /maksimal 2048 karakter/)
  assert.equal(conn.calls.length, 0, 'deskripsi kepanjangan tidak boleh terkirim ke WhatsApp')
  const m = baseM()
  await setdescHandler(m, baseCtx(conn, { text: 'a'.repeat(2048), command: 'setdesc' }))
  assert.equal(conn.calls[0].desc.length, 2048, 'pas 2048 karakter lolos')
  assert.match(m.__replies[0], /2048\/2048 karakter/)
})

test('opengc/closegc memetakan ke setting announcement yang benar', async () => {
  const conn = fakeConn()
  await bukatutupHandler(baseM(), baseCtx(conn, { command: 'closegc' }))
  assert.equal(conn.calls[0].setting, 'announcement')
  const conn2 = fakeConn()
  const m2 = baseM()
  await bukatutupHandler(m2, baseCtx(conn2, { command: 'opengc' }))
  assert.equal(conn2.calls[0].setting, 'not_announcement')
  assert.match(m2.__replies[0], /Grup dibuka/)
})

test('.linkgc: merakit URL dari kode undangan', async () => {
  const conn = fakeConn()
  const m = baseM()
  await linkgcHandler(m, baseCtx(conn, { command: 'linkgc' }))
  assert.match(m.__replies[0], /https:\/\/chat\.whatsapp\.com\/KODEUNDANGAN123/)
})
