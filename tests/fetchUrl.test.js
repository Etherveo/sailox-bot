import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mimeToExt, parseFetchArgs, planFetch, MAX_REPLY_CHARS } from '../lib/helpers/fetchUrl.js'

test('mimeToExt: peta umum + fallback bin + abaikan parameter', () => {
  assert.equal(mimeToExt('image/png'), 'png')
  assert.equal(mimeToExt('application/json; charset=utf-8'), 'json')
  assert.equal(mimeToExt('VIDEO/MP4'), 'mp4')
  assert.equal(mimeToExt('application/x-buatanku'), 'bin')
  assert.equal(mimeToExt(''), 'bin')
})

test('parseFetchArgs: flag -d, skema otomatis, validasi', () => {
  assert.deepEqual(parseFetchArgs('https://a/b.png', { usedPrefix: '.', command: 'fetch' }).forceDoc, false)
  const d = parseFetchArgs('-d example.com/x', { usedPrefix: '.', command: 'get' })
  assert.equal(d.forceDoc, true)
  assert.equal(d.url.href, 'http://example.com/x')
  const throwsMsg = fn => { try { fn() } catch (e) { return String(e) } return null }
  assert.match(throwsMsg(() => parseFetchArgs('')), /Contoh penggunaan/)
  assert.match(throwsMsg(() => parseFetchArgs('-d')), /Contoh penggunaan/)
  assert.match(throwsMsg(() => parseFetchArgs('http://exa mple.com/x')), /URL tidak valid/)
})

test('planFetch: media tidak dipaksa dokumen', () => {
  const p = planFetch({ url: 'https://a/foto', contentType: 'image/jpeg', buffer: Buffer.from([1, 2]) })
  assert.equal(p.kind, 'media')
  assert.equal(p.filename, 'foto.jpg')
  const v = planFetch({ url: 'https://a/v.mp4', contentType: 'video/mp4', buffer: Buffer.alloc(3) })
  assert.equal(v.kind, 'media')
  assert.equal(v.filename, 'v.mp4', 'ekstensi dari path dipertahankan')
  const doc = planFetch({ url: 'https://a/foto', contentType: 'image/jpeg', buffer: Buffer.alloc(3), forceDoc: true })
  assert.equal(doc.kind, 'document')
})

test('planFetch: teks pendek dibalas langsung, teks panjang dipotong + file', () => {
  const short = planFetch({ url: 'https://a/t', contentType: 'text/plain', buffer: Buffer.from('halo') })
  assert.equal(short.kind, 'text')
  assert.equal(short.text, 'halo')
  assert.equal(short.truncated, false)
  const long = planFetch({ url: 'https://a/t', contentType: 'application/json', buffer: Buffer.alloc(MAX_REPLY_CHARS + 10, 'x') })
  assert.equal(long.kind, 'text')
  assert.equal(long.truncated, true)
  assert.ok(long.text.endsWith('…(dipotong, file lengkap dilampirkan)'))
  assert.equal(long.text.length, MAX_REPLY_CHARS + '\n\n…(dipotong, file lengkap dilampirkan)'.length)
})

test('planFetch: tipe lain menjadi dokumen berketerangan', () => {
  const p = planFetch({ url: 'https://a/arsip', contentType: 'application/zip', buffer: Buffer.alloc(2048) })
  assert.equal(p.kind, 'document')
  assert.equal(p.filename, 'arsip.zip')
  assert.ok(p.caption.includes('2.0 KB'))
})

test('plugin tools/fetch.js terdaftar owner-only dan terimpor lewat loader', async () => {
  const { createPluginLoader } = await import('../lib/plugins/loader.js')
  const errors = []
  const loader = createPluginLoader({ root: new URL('../plugins/', import.meta.url).pathname, publish: false, onError: e => errors.push(e), warn: () => {} })
  const r = await loader.reload('tools/fetch.js')
  assert.equal(r.ok, true, 'plugin fetch harus bisa dimuat')
  const plugin = loader.get('tools/fetch.js')
  assert.equal(plugin.owner, true, 'fetch/get harus owner-only')
  assert.match(String(plugin.command), /fetch\|get/, 'alias get terdaftar')
  assert.deepEqual(errors, [])
  await loader.close()
})
