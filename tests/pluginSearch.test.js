import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { parseSearchArgs, selectCategories, categoryOf, searchPlugins } from '../lib/helpers/pluginSearch.js'
import cariHandler from '../plugins/owner/cariplugin.js'

const conn = { role: 'main' }
function fakeM() { const replies = []; return { chat: 'tes@s.whatsapp.net', replies, reply: async teks => { replies.push(String(teks)) } } }
const ctx = (command, text) => ({ conn, command, text, args: text ? text.split(/\s+/) : [] })

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-cp-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'owner'), { recursive: true })
  await fs.mkdir(path.join(root, 'main'), { recursive: true })
  await fs.writeFile(path.join(root, 'owner', 'alpha.js'), `// tentang Sailox\nlet h = async () => {}; h.tags = ['owner']\nconst x = 'sailox sailox'\n`)
  await fs.writeFile(path.join(root, 'owner', 'beta.js'), `// tentang SAILOX kapital\n`)
  await fs.writeFile(path.join(root, 'main', 'gamma.js'), `// kosong\n`)
  global.pluginLoader = { root }
  t.after(() => { delete global.pluginLoader })
  return root
}

test('regex command cp/cplugin/cariplugin/pluginsearch', () => {
  for (const c of ['cp', 'carip', 'cplugin', 'cariplugin', 'pluginsearch']) assert.match(c, cariHandler.command)
  for (const c of ['cpx', 'pcariplugin']) assert.doesNotMatch(c, cariHandler.command)
})

test('parseSearchArgs: tata bahasa baru — flag, filter kurung tervalidasi, keyword bebas', () => {
  const cats = ['main', 'owner', 'tools']
  assert.equal(parseSearchArgs('', cats), null)
  assert.equal(parseSearchArgs('   ', cats), null)
  assert.equal(parseSearchArgs('-s', cats), null)
  assert.equal(parseSearchArgs('(owner)', cats), null, 'filter tanpa keyword = null')
  assert.deepEqual(parseSearchArgs('sailox', cats), { keyword: 'sailox', sensitive: false, categories: null, filterText: '' })
  assert.deepEqual(parseSearchArgs('kata bebas multi kata', cats), { keyword: 'kata bebas multi kata', sensitive: false, categories: null, filterText: '' })
  assert.deepEqual(parseSearchArgs('baris satu\nbaris dua', cats).keyword, 'baris satu\nbaris dua', 'keyword multi-baris utuh')
  assert.deepEqual(parseSearchArgs('-s Sailox', cats), { keyword: 'Sailox', sensitive: true, categories: null, filterText: '' })
  assert.deepEqual(parseSearchArgs('-sendiri', cats), { keyword: '-sendiri', sensitive: false, categories: null, filterText: '' }, '-s yang menempel kata bukan flag')
  const satu = parseSearchArgs('(owner) jid', cats)
  assert.equal(satu.keyword, 'jid')
  assert.deepEqual([...satu.categories], ['owner'])
  assert.equal(satu.filterText, 'owner')
  const lengkap = parseSearchArgs('-s (main-owner) conn.sendMessage', cats)
  assert.equal(lengkap.sensitive, true)
  assert.deepEqual([...lengkap.categories].sort(), ['main', 'owner'])
  assert.equal(lengkap.keyword, 'conn.sendMessage')
  const multi = parseSearchArgs('(main, tools) a (b) c', cats)
  assert.deepEqual([...multi.categories].sort(), ['main', 'tools'])
  assert.equal(multi.keyword, 'a (b) c', 'kurung sesudah yang pertama = keyword')
  const bukanFilter = parseSearchArgs('(tidakada) jid', cats)
  assert.equal(bukanFilter.categories, null)
  assert.equal(bukanFilter.keyword, '(tidakada) jid', 'isi kurung bukan kategori sah -> seluruhnya keyword')
  const kode = parseSearchArgs('(async () => x', cats)
  assert.equal(kode.categories, null)
  assert.equal(kode.keyword, '(async () => x')
})

test('selectCategories: kosong/satu/rentang/multi/kategori tak dikenal', () => {
  const cats = ['main', 'owner', 'tools']
  assert.equal(selectCategories(cats, ''), null)
  assert.deepEqual([...selectCategories(cats, 'owner')], ['owner'])
  assert.deepEqual([...selectCategories(cats, 'MAIN-Owner')], ['main', 'owner'])
  assert.deepEqual([...selectCategories(cats, 'tools, main')], ['tools', 'main'])
  assert.throws(() => selectCategories(cats, 'tidakada'), /Kategori tidak ditemukan/)
  assert.throws(() => selectCategories(cats, 'main-'), /Format rentang/)
})

test('categoryOf: direktori kategori vs root', () => {
  assert.equal(categoryOf('owner/alpha.js'), 'owner')
  assert.equal(categoryOf('alpha.js'), '(root)')
})

test('searchPlugins: insensitive bawaan, -s sensitif, filter kategori, urut terbanyak', async t => {
  const root = await fixture(t)
  let m = await searchPlugins({ pluginsDir: root, keyword: 'sailox' })
  assert.deepEqual(m.map(x => x.file), ['owner/alpha.js', 'owner/beta.js'])
  assert.equal(m[0].count, 3)
  m = await searchPlugins({ pluginsDir: root, keyword: 'sailox', sensitive: true })
  assert.deepEqual(m.map(x => x.file), ['owner/alpha.js'])
  m = await searchPlugins({ pluginsDir: root, keyword: 'SAILOX', sensitive: true })
  assert.deepEqual(m.map(x => x.file), ['owner/beta.js'])
  m = await searchPlugins({ pluginsDir: root, keyword: 'sailox', categories: new Set(['main']) })
  assert.deepEqual(m, [])
  m = await searchPlugins({ pluginsDir: root, keyword: 'tentang' })
  assert.deepEqual(m.map(x => x.file), ['owner/alpha.js', 'owner/beta.js'])
})

test('handler: tanpa kata kunci memakai pesan usage ala legacy', async t => {
  await fixture(t)
  const m = fakeM()
  await assert.rejects(cariHandler(m, ctx('cp', '')), /Masukkan kata kunci/)
  assert.deepEqual(m.replies, [])
})

test('handler: hasil dibalas dengan nama file, path kategori, dan jumlah', async t => {
  await fixture(t)
  const m = fakeM()
  await cariHandler(m, ctx('cp', 'sailox'))
  assert.match(m.replies[0], /Ditemukan \*2\* plugin yang mengandung \*"sailox"\*/)
  assert.match(m.replies[0], /alpha _\[owner\/alpha\.js\]_ — 3×/)
  assert.match(m.replies[0], /beta _\[owner\/beta\.js\]_ — 1×/)
})

test('handler: -s case-sensitive, filter kurung, keyword multi-kata', async t => {
  await fixture(t)
  let m = fakeM()
  await cariHandler(m, ctx('cp', '-s sailox'))
  assert.match(m.replies[0], /Ditemukan \*1\* plugin/)
  m = fakeM()
  await cariHandler(m, ctx('cp', 'tentang sailox'))
  assert.match(m.replies[0], /Ditemukan \*2\* plugin yang mengandung \*"tentang sailox"\*/, 'frasa multi-kata dicari apa adanya')
  m = fakeM()
  await cariHandler(m, ctx('cp', '(owner) sailox'))
  assert.match(m.replies[0], /Ditemukan \*2\* plugin/)
  assert.match(m.replies[0], /\(kategori: owner\)/)
  m = fakeM()
  await assert.rejects(cariHandler(m, ctx('cp', '(main) sailox')), /Tidak ada plugin yang mengandung/)
  m = fakeM()
  await assert.rejects(cariHandler(m, ctx('cp', '(tidakada) sailox')), /Tidak ada plugin yang mengandung/, 'kurung tak dikenal = keyword, bukan error kategori')
})

test('handler: ditolak di subbot seperti listplugin', async t => {
  await fixture(t)
  const m = fakeM()
  await assert.rejects(cariHandler(m, { conn: { role: 'sub' }, command: 'cp', text: 'sailox', args: ['sailox'] }), /hanya untuk bot utama/)
})
