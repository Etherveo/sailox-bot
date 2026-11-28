import { test } from 'node:test'
import assert from 'node:assert/strict'
import handler, { parsePollInput, pollUsage } from '../plugins/group/polling.js'
import { buildMenuText } from '../plugins/main/menu.js'

const fakeConn = (failWith) => ({
  sent: [],
  sendMessage: async function (jid, content) {
    if (failWith) throw failWith
    this.sent.push({ jid, content })
  },
})
const baseM = (over = {}) => ({ chat: '120363027117842341@g.us', sender: '6282348181097@s.whatsapp.net', reply: async () => {}, ...over })

test('parsePollInput: single-select default (selectableCount 1)', () => {
  assert.deepEqual(parsePollInput('Makan apa? | Nasi goreng | Mie ayam'), {
    name: 'Makan apa?',
    values: ['Nasi goreng', 'Mie ayam'],
    selectableCount: 1,
  })
})

test('parsePollInput: -multi (case-insensitive) jadi selectableCount 0', () => {
  assert.equal(parsePollInput('-multi Pilih | A | B').selectableCount, 0)
  assert.equal(parsePollInput('-MULTI Pilih | A | B').selectableCount, 0)
  assert.equal(parsePollInput('-multi   Pilih | A | B').name, 'Pilih')
})

test('parsePollInput: validasi — kosong, tanpa opsi, 1 opsi, >12 opsi', () => {
  assert.throws(() => parsePollInput(''), err => err === pollUsage('.'))
  assert.throws(() => parsePollInput('-multi'), /Masukkan judul dan opsi polling\./)
  assert.throws(() => parsePollInput('Judul doang'), /Minimal harus ada 2 opsi/)
  assert.throws(() => parsePollInput('Judul | Cuma satu'), /Minimal harus ada 2 opsi/)
  const banyak = 'J | ' + Array.from({ length: 13 }, (_, i) => 'O' + i).join(' | ')
  assert.throws(() => parsePollInput(banyak), /Maksimal hanya 12 opsi/)
  assert.equal(parsePollInput('J | ' + Array.from({ length: 12 }, (_, i) => 'O' + i).join(' | ')).values.length, 12)
})

test('parsePollInput: validasi panjang judul & opsi', () => {
  assert.throws(() => parsePollInput('x'.repeat(256) + ' | A | B'), /Judul terlalu panjang/)
  assert.throws(() => parsePollInput('J | ' + 'y'.repeat(101) + ' | B'), /Maks 100 karakter/)
})

test('handler: kirim poll ke grup pemanggil, tanpa -multi = 1 pilihan', async () => {
  const conn = fakeConn()
  await handler(baseM(), { conn, text: 'Makan apa? | Nasi goreng | Mie ayam', usedPrefix: '.' })
  assert.equal(conn.sent.length, 1)
  assert.equal(conn.sent[0].jid, '120363027117842341@g.us')
  assert.deepEqual(conn.sent[0].content.poll, {
    name: 'Makan apa?',
    values: ['Nasi goreng', 'Mie ayam'],
    selectableCount: 1,
  })
})

test('handler: -multi terkirim sebagai selectableCount 0', async () => {
  const conn = fakeConn()
  await handler(baseM(), { conn, text: '-multi Pilih | A | B', usedPrefix: '.' })
  assert.equal(conn.sent[0].content.poll.selectableCount, 0)
})

test('handler: teks kosong melempar format pemakaian; gagal kirim melempar pesan gagal', async () => {
  const conn = fakeConn()
  await assert.rejects(handler(baseM(), { conn, text: '', usedPrefix: '.' }), /Format:/)
  const badConn = fakeConn(new Error('boom'))
  await assert.rejects(handler(baseM(), { conn: badConn, text: 'J | A | B', usedPrefix: '.' }), /Gagal membuat polling:\nboom/)
})

test('handler: metadata — command poll/polling, grup-only, tag group, tanpa limit', () => {
  assert.equal(handler.command.test('poll'), true)
  assert.equal(handler.command.test('polling'), true)
  assert.equal(handler.command.test('polls'), false)
  assert.equal(handler.group, true)
  assert.deepEqual(handler.tags, ['group'])
  assert.equal(handler.limit, undefined)
  assert.equal(handler.admin, undefined)
})

test('menu: .poll muncul di kategori Group', () => {
  const text = buildMenuText({ plugins: [handler], input: 'group', prefix: '.' })
  assert.match(text, /GROUP/)
  assert.match(text, /\.poll\/polling/)
})
