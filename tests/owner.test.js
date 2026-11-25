// tests/owner.test.js — .owner (plugins/info/owner.js):
// kirim contact message owner index pertama saja (founder[0], jatuh ke
// owner[0]), sebagai vCard via conn.sendContact — bukan teks nomor.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import handler from '../plugins/info/owner.js'

function fakeConn() {
  const sent = []
  return { sent, sendContact: async (jid, contacts, quoted) => { sent.push({ jid, contacts, quoted }); return true } }
}
function fakeM(over = {}) {
  return { chat: '120363419575108739@g.us', sender: '147368951459939@lid', ...over }
}
// Pasang global founder/owner palsu selama satu tes, lalu kembalikan.
async function withConfig({ founder, owner }, fn) {
  const prevF = global.founder, prevO = global.owner
  if (founder === undefined) delete global.founder; else global.founder = founder
  if (owner === undefined) delete global.owner; else global.owner = owner
  try { await fn() } finally {
    if (prevF === undefined) delete global.founder; else global.founder = prevF
    if (prevO === undefined) delete global.owner; else global.owner = prevO
  }
}

test('command: .owner saja, bebas limit, tag info', () => {
  assert.equal(handler.command.test('owner'), true)
  assert.equal(handler.command.test('Owner'), true)
  assert.equal(handler.command.test('ownerx'), false)
  assert.equal(handler.command.test('owners'), false)
  assert.equal(handler.limit, undefined, 'bebas limit — keputusan Veo 2026-11-25')
  assert.deepEqual(handler.tags, ['info'])
  assert.deepEqual(handler.help, ['owner'])
})

test('owner: kirim contact message founder pertama saja', async () => {
  const conn = fakeConn()
  const m = fakeM()
  await withConfig({ founder: [['6282348181097', '147368951459939', 'Veo'], ['6281111111111', '', 'Owner Dua']], owner: [] }, async () => {
    await handler(m, { conn })
  })
  assert.equal(conn.sent.length, 1)
  assert.equal(conn.sent[0].jid, '120363419575108739@g.us')
  assert.deepEqual(conn.sent[0].contacts, [['6282348181097@s.whatsapp.net', 'Veo']])
  assert.equal(conn.sent[0].quoted, m)
})

test('owner: founder kosong -> pakai owner pertama', async () => {
  const conn = fakeConn()
  await withConfig({ founder: [], owner: [['6289988776655', '', 'Bos']] }, async () => {
    await handler(fakeM(), { conn })
  })
  assert.deepEqual(conn.sent[0].contacts, [['6289988776655@s.whatsapp.net', 'Bos']])
})

test('owner: tanpa nama di config -> fallback "Owner"', async () => {
  const conn = fakeConn()
  await withConfig({ founder: [['6282348181097', '']], owner: [] }, async () => {
    await handler(fakeM(), { conn })
  })
  assert.deepEqual(conn.sent[0].contacts, [['6282348181097@s.whatsapp.net', 'Owner']])
})

test('owner: tanpa founder/owner -> throw, tidak kirim apa-apa', async () => {
  const conn = fakeConn()
  await withConfig({ founder: [], owner: [] }, async () => {
    await assert.rejects(handler(fakeM(), { conn }), /Owner belum diatur/)
  })
  assert.equal(conn.sent.length, 0)
})
