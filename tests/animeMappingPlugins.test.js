import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAnimeNameMap } from '../lib/helpers/animeNameMap.js'
import addmapping from '../plugins/owner/addmapping.js'
import listmapping from '../plugins/owner/listmapping.js'
import delmapping from '../plugins/owner/delmapping.js'
import editmapping from '../plugins/owner/editmapping.js'
import editmappingkey from '../plugins/owner/editmappingkey.js'
import clearmapping from '../plugins/owner/clearmapping.js'
import ceknama from '../plugins/owner/ceknama.js'

function fakeM() {
  const replies = []
  return { chat: 'tes@s.whatsapp.net', sender: 'founder@s.whatsapp.net', replies, reply: async teks => { replies.push(String(teks)) } }
}

function useTempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sailox-amplugins-'))
  const store = createAnimeNameMap({ filePath: path.join(dir, 'anime-map.json') })
  globalThis.animeNameMap = store
  t.after(() => { delete globalThis.animeNameMap; fs.rmSync(dir, { recursive: true, force: true }) })
  return store
}

async function thrown(fn) {
  try { await fn(); return null } catch (e) { return String(e?.message ?? e) }
}

const ctx = (text, command) => ({ text, usedPrefix: '.', command })

test('amp: tambah mapping baru lalu menimpa yang lama', async t => {
  const store = useTempStore(t)
  const m1 = fakeM()
  await addmapping(m1, ctx('NEWKEY | Judul Baru | Season 2', 'amp'))
  assert.match(m1.replies.at(-1), /berhasil ditambahkan/)
  assert.deepEqual(store.get('NEWKEY'), { title: 'Judul Baru', season: 'Season 2' })

  const m2 = fakeM()
  await addmapping(m2, ctx('NEWKEY | Judul Revisi', 'addmapping'))
  assert.match(m2.replies.at(-1), /menimpa yang lama/)
  assert.deepEqual(store.get('NEWKEY'), { title: 'Judul Revisi' })
})

test('amp: format salah ditolak', async t => {
  useTempStore(t)
  assert.match(await thrown(() => addmapping(fakeM(), ctx('', 'amp'))), /Format:/)
  assert.match(await thrown(() => addmapping(fakeM(), ctx('HANYAKUNCI', 'amp'))), /wajib diisi/)
})

test('listmapping: kosong lalu terisi', async t => {
  const store = useTempStore(t)
  const m1 = fakeM()
  await listmapping(m1, ctx('', 'listmapping'))
  assert.match(m1.replies.at(-1), /Belum ada mapping/)
  store.add('REDRIVER', { title: 'Sora wa Akai Kawa no Hotori' })
  const m2 = fakeM()
  await listmapping(m2, ctx('', 'lmp'))
  assert.match(m2.replies.at(-1), /1\. \*REDRIVER\*/)
  assert.match(m2.replies.at(-1), /Sora wa Akai Kawa no Hotori/)
})

test('delmapping: hapus yang ada, tolak yang tidak ada', async t => {
  const store = useTempStore(t)
  store.add('HAPUSAKU', { title: 'X' })
  const m1 = fakeM()
  await delmapping(m1, ctx('HAPUSAKU', 'dmp'))
  assert.match(m1.replies.at(-1), /berhasil dihapus/)
  assert.equal(store.get('HAPUSAKU'), null)
  const m2 = fakeM()
  await delmapping(m2, ctx('HAPUSAKU', 'delmapping'))
  assert.match(m2.replies.at(-1), /tidak ditemukan/)
})

test('editmapping: ubah sebagian, "-" menghapus field, kunci hilang ditolak', async t => {
  const store = useTempStore(t)
  store.add('EDIT', { title: 'Judul Lama', season: 'Season 1' })
  const m1 = fakeM()
  await editmapping(m1, ctx('EDIT |  | Season 2', 'emp'))
  assert.deepEqual(store.get('EDIT'), { title: 'Judul Lama', season: 'Season 2' }, 'field kosong tidak mengubah')
  const m2 = fakeM()
  await editmapping(m2, ctx('EDIT | Judul Baru | -', 'editmapping'))
  assert.deepEqual(store.get('EDIT'), { title: 'Judul Baru' }, '"-" menghapus season')
  assert.match(await thrown(() => editmapping(fakeM(), ctx('HILANG | X', 'emp'))), /tidak ditemukan/)
})

test('editmappingkey: pindah kunci, konflik dan kunci hilang ditolak', async t => {
  const store = useTempStore(t)
  store.add('LAMA', { title: 'Satu' })
  store.add('SUDAHADA', { title: 'Dua' })
  const m = fakeM()
  await editmappingkey(m, ctx('LAMA | BARU', 'empk'))
  assert.match(m.replies.at(-1), /Key baru: BARU/)
  assert.equal(store.get('LAMA'), null)
  assert.equal(store.get('BARU').title, 'Satu')
  assert.match(await thrown(() => editmappingkey(fakeM(), ctx('BARU | SUDAHADA', 'editmappingkey'))), /sudah ada/)
  assert.match(await thrown(() => editmappingkey(fakeM(), ctx('HILANG | X', 'empk'))), /tidak ditemukan/)
})

test('clearmapping: wajib konfirmasi "ya", lalu kosong sungguhan', async t => {
  const store = useTempStore(t)
  store.add('A', { title: 'Satu' })
  store.add('B', { title: 'Dua' })
  const m1 = fakeM()
  await clearmapping(m1, ctx('', 'cmp'))
  assert.match(m1.replies.at(-1), /menghapus SEMUA mapping anime \(2 entri\)/)
  assert.equal(Object.keys(store.list()).length, 2, 'tanpa konfirmasi tidak ada yang terhapus')
  const m2 = fakeM()
  await clearmapping(m2, ctx('ya', 'clearmapping'))
  assert.match(m2.replies.at(-1), /Total mapping dihapus: \*2\*/)
  assert.deepEqual(store.list(), {})
  const m3 = fakeM()
  await clearmapping(m3, ctx('ya', 'cmp'))
  assert.match(m3.replies.at(-1), /sudah kosong/)
})

test('ceknama: pratinjau nama final, tanpa kecocokan, dan kunci cocok tanpa episode', async t => {
  const store = useTempStore(t)
  store.add('REDRIVER', { title: 'Sora wa Akai Kawa no Hotori' })
  const m1 = fakeM()
  await ceknama(m1, ctx('Kuramanime-REDRIVER-01-720p.mp4', 'ceknama'))
  assert.match(m1.replies.at(-1), /\[NEW\] Sora wa Akai Kawa no Hotori - Episode 01 Subtitle Indonesia 720p\.mp4/)
  const m2 = fakeM()
  await ceknama(m2, ctx('file-acak-01.mkv', 'ceknama'))
  assert.match(m2.replies.at(-1), /Tidak ada mapping yang cocok/)
  const m3 = fakeM()
  await ceknama(m3, ctx('Kuramanime-REDRIVER-PV.mp4', 'ceknama'))
  assert.match(m3.replies.at(-1), /tidak bisa disusun/)
})

test('metadata: semua founder-only dan alias legacy cocok', () => {
  for (const h of [addmapping, listmapping, delmapping, editmapping, editmappingkey, clearmapping, ceknama]) {
    assert.equal(h.founder, true)
    assert.deepEqual(h.tags, ['owner'])
  }
  // Alias yang didokumentasikan help legacy — terverifikasi empiris
  // terhadap regex aslinya (regex legacy memang menolak bentuk seperti
  // 'amap'/'addmap'; dipertahankan apa adanya).
  for (const c of ['amp', 'addmapping']) assert.match(c, addmapping.command)
  assert.doesNotMatch('amap', addmapping.command)
  assert.doesNotMatch('addmap', addmapping.command)
  for (const c of ['lmp', 'listmapping']) assert.match(c, listmapping.command)
  for (const c of ['dmp', 'delmapping', 'deletemapping']) assert.match(c, delmapping.command)
  for (const c of ['emp', 'editmapping']) assert.match(c, editmapping.command)
  for (const c of ['empk', 'editmappingkey']) assert.match(c, editmappingkey.command)
  for (const c of ['cmp', 'clearmapping']) assert.match(c, clearmapping.command)
  assert.match('ceknama', ceknama.command)
})
