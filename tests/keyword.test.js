import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import handler, { createKeywordStore } from '../plugins/fun/keyword.js'

// Port legacy plugins/store-keyword.js: addkey/delkey/edkey/listkey +
// auto-respon keyword. Diuji pakai store berkas sementara lewat
// globalThis.keywordStore; tidak ada koneksi WhatsApp yang dibuka.
function fakeM() {
  const replies = []
  return { chat: '123@g.us', sender: 'owner@s.whatsapp.net', fromMe: false, text: '', replies, reply: async teks => { replies.push(String(teks)) } }
}

function useTempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sailox-keyword-'))
  const store = createKeywordStore({ filePath: path.join(dir, 'keyword-store.json') })
  globalThis.keywordStore = store
  t.after(() => { delete globalThis.keywordStore; fs.rmSync(dir, { recursive: true, force: true }) })
  return store
}

async function thrown(fn) {
  try { await fn(); return null } catch (e) { return String(e?.message ?? e) }
}

const ctx = (text, command) => ({ text, usedPrefix: '.', command })

test('addkey: tambah keyword baru, kunci disimpan lowercase', async t => {
  const store = useTempStore(t)
  const m = fakeM()
  await handler(m, ctx('Halo|Hai juga!', 'addkey'))
  assert.match(m.replies.at(-1), /Keyword "Halo" ditambahkan/)
  assert.equal(store.get('halo'), 'Hai juga!')
  assert.equal(store.get('Halo'), null, 'kunci selalu lowercase')
})

test('addkey: respon boleh mengandung | (disambung lagi)', async t => {
  const store = useTempStore(t)
  await handler(fakeM(), ctx('a|b|c|d', 'addkey'))
  assert.equal(store.get('a'), 'b|c|d')
})

test('addkey: format salah dan nilai kosong ditolak', async t => {
  useTempStore(t)
  assert.match(await thrown(() => handler(fakeM(), ctx('TANPAPEMISAH', 'addkey'))), /Salah, woy!/)
  assert.match(await thrown(() => handler(fakeM(), ctx('kunci|', 'addkey'))), /gak boleh kosong/)
  assert.match(await thrown(() => handler(fakeM(), ctx('|respon', 'addkey'))), /gak boleh kosong/)
})

test('addkey: kunci __proto__ ditolak (anti prototype pollution)', async t => {
  const store = useTempStore(t)
  assert.match(await thrown(() => handler(fakeM(), ctx('__proto__|jahat', 'addkey'))), /tidak valid/)
  assert.equal(store.get('__proto__'), null)
  assert.equal({}.polluted, undefined)
})

test('delkey: hapus keyword yang ada, yang tidak ada ditolak', async t => {
  const store = useTempStore(t)
  store.add('hapus', 'aku')
  const m = fakeM()
  await handler(m, ctx('HAPUS', 'delkey'))
  assert.match(m.replies.at(-1), /Keyword "hapus" dihapus/)
  assert.equal(store.get('hapus'), null)
  assert.match(await thrown(() => handler(fakeM(), ctx('hapus', 'delkey'))), /tidak ditemukan/)
  assert.match(await thrown(() => handler(fakeM(), ctx('', 'delkey'))), /Salah\. Gini:/)
})

test('edkey: ubah respon keyword yang ada, yang tidak ada ditolak', async t => {
  const store = useTempStore(t)
  store.add('lama', 'v1')
  const m = fakeM()
  await handler(m, ctx('LAMA|v2 baru', 'edkey'))
  assert.match(m.replies.at(-1), /Keyword "lama" diperbarui/)
  assert.equal(store.get('lama'), 'v2 baru')
  assert.match(await thrown(() => handler(fakeM(), ctx('nggakada|v9', 'edkey'))), /tidak ditemukan/)
  assert.match(await thrown(() => handler(fakeM(), ctx('TANPAPEMISAH', 'edkey'))), /Salah\. Kek gini:/)
})

test('listkey: kosong dan berisi, terurut alfabetis', async t => {
  useTempStore(t)
  const m0 = fakeM()
  await handler(m0, ctx('', 'listkey'))
  assert.equal(m0.replies.at(-1), 'Belum ada keyword tersimpan.')
  await handler(fakeM(), ctx('zeta|z', 'addkey'))
  await handler(fakeM(), ctx('alpha|a', 'addkey'))
  const m = fakeM()
  await handler(m, ctx('', 'listkey'))
  assert.equal(m.replies.at(-1), '📦 *Daftar Keyword Tersimpan:*\n\n• alpha\n• zeta')
})

test('before: pesan sama persis dengan keyword dibalas responnya', async t => {
  const store = useTempStore(t)
  store.add('halo', 'Hai juga!')
  const m = fakeM()
  m.text = 'HALO'
  assert.equal(await handler.before(m), true)
  assert.deepEqual(m.replies, ['Hai juga!'])
})

test('before: bukan keyword, pesan bot sendiri, dan teks kosong dilewati', async t => {
  const store = useTempStore(t)
  store.add('halo', 'Hai juga!')
  const m1 = fakeM(); m1.text = 'halo semua'
  assert.equal(await handler.before(m1), false)
  assert.deepEqual(m1.replies, [])
  const m2 = fakeM(); m2.text = 'halo'; m2.fromMe = true
  assert.equal(await handler.before(m2), false)
  assert.deepEqual(m2.replies, [])
  const m3 = fakeM(); m3.text = '   '
  assert.equal(await handler.before(m3), false)
})

test('keyword: metadata plugin — tag fun, owner-only, empat perintah', () => {
  assert.deepEqual(handler.tags, ['fun'])
  assert.equal(handler.owner, true)
  assert.ok(handler.command.test('addkey') && handler.command.test('delkey'))
  assert.ok(handler.command.test('edkey') && handler.command.test('listkey'))
  assert.ok(!handler.command.test('addkeys') && !handler.command.test('key'))
  assert.deepEqual(handler.help, ['addkey keyword|respon', 'delkey keyword', 'edkey keyword|respon baru', 'listkey'])
})
