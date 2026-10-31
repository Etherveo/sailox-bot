import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createPluginLoader } from '../lib/plugins/loader.js'
import { savePluginFile, scanPluginFiles } from '../lib/plugins/files.js'
import saveHandler from '../plugins/owner/saveplugin.js'
import getHandler from '../plugins/owner/getplugin.js'
import deleteHandler from '../plugins/owner/deleteplugin.js'
import listHandler from '../plugins/owner/listplugin.js'
const code = tag => `let handler = async () => {}; handler.tags = ['${tag}']; handler.command = ['hello']; export default handler`
const conn = { role: 'main', sendFile: async () => { throw new Error('tidak dipakai di tes ini') } }
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-owner-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const loader = createPluginLoader({ root, publish: false, onError: () => {}, warn: () => {} })
  global.pluginLoader = loader
  t.after(() => { delete global.pluginLoader })
  return { root, loader }
}
function fakeM(quoted = null) { const replies = []; return { chat: 'tes@s.whatsapp.net', quoted, replies, reply: async teks => { replies.push(String(teks)) } } }
const ctx = (command, text) => ({ conn, command, text, args: text ? text.split(/\s+/) : [] })

test('regex command sp/gp/dp/lp sesuai pola save/get/delete/list plugin', () => {
  for (const c of ['sp', 'savep', 'splugin', 'saveplugin']) assert.match(c, saveHandler.command)
  for (const c of ['gp', 'getp', 'gplugin', 'getplugin']) assert.match(c, getHandler.command)
  for (const c of ['dp', 'delp', 'deletep', 'dplugin', 'deleteplugin']) assert.match(c, deleteHandler.command)
  for (const c of ['lp', 'listp', 'lplugin', 'listplugin']) assert.match(c, listHandler.command)
})

test('sp nama: folder dari tag pertama + hot-reload langsung aktif tanpa restart', async t => {
  const { root, loader } = await setup(t)
  const m = fakeM({ text: code('info') })
  await saveHandler(m, ctx('sp', 'auto'))
  assert.ok(await fs.stat(path.join(root, 'info/auto.js')))
  assert.ok(loader.get('info/auto.js'), 'plugin harus sudah termuat lewat reload eksplisit')
  assert.match(m.replies.at(-1), /info\/auto\.js/)
  assert.match(m.replies.at(-1), /hot-reload/)
})

test('sp kategori-nama: simpan sebagai nama.js di folder kategori input, bukan input mentah', async t => {
  const { root, loader } = await setup(t)
  const m = fakeM({ text: code('main') })
  await saveHandler(m, ctx('sp', 'owner-eksplisit'))
  assert.ok(await fs.stat(path.join(root, 'owner/eksplisit.js')))
  await assert.rejects(fs.stat(path.join(root, 'main/owner-eksplisit.js')))
  await assert.rejects(fs.stat(path.join(root, 'main/eksplisit.js')))
  assert.ok(loader.get('owner/eksplisit.js'))
  // kategori yang belum ada pun dibuat
  const m2 = fakeM({ text: code('main') })
  await saveHandler(m2, ctx('sp', 'anime-baru'))
  assert.ok(await fs.stat(path.join(root, 'anime/baru.js')))
})

test('sp menolak plugin syntax error sebelum menulis apa pun (perilaku legacy)', async t => {
  const { root } = await setup(t)
  const m = fakeM({ text: 'export default (' })
  await assert.rejects(saveHandler(m, ctx('sp', 'rusak')), /syntax error/i)
  assert.deepEqual(await scanPluginFiles(root), [])
})

test('sp dari reply file .js (ekstensi divalidasi) dan menolak ekstensi lain', async t => {
  const { root, loader } = await setup(t)
  const berkas = { mediaMessage: {}, mediaType: 'document', msg: { fileName: 'dari-file.JS' }, text: '', download: async () => Buffer.from(code('tools')) }
  const m = fakeM(berkas)
  await saveHandler(m, ctx('sp', 'fileku'))
  assert.ok(await fs.stat(path.join(root, 'tools/fileku.js')))
  assert.ok(loader.get('tools/fileku.js'))
  const jahat = { mediaMessage: {}, mediaType: 'document', msg: { fileName: 'jahat.txt' }, text: '', download: async () => Buffer.from(code('tools')) }
  await assert.rejects(saveHandler(fakeM(jahat), ctx('sp', 'jahat')), /ekstensi \.js/)
  assert.deepEqual((await scanPluginFiles(root)).filter(id => id.includes('jahat')), [])
})

test('gp/dp bentuk kategori-nama + nama utuh lama (owner-clearcache) tidak tertukar', async t => {
  const { root, loader } = await setup(t)
  await savePluginFile({ root, loader, name: 'owner-clearcache', code: code('owner') })
  await savePluginFile({ root, loader, name: 'target', code: code('owner') })
  const mg = fakeM()
  await getHandler(mg, ctx('gp', 'owner-target'))
  assert.equal(mg.replies.at(-1), code('owner'))
  const mg2 = fakeM()
  await getHandler(mg2, ctx('gp', 'owner-clearcache'))
  assert.equal(mg2.replies.at(-1), code('owner'))
  const md = fakeM()
  await deleteHandler(md, ctx('dp', 'owner-target'))
  await assert.rejects(fs.stat(path.join(root, 'owner/target.js')))
  assert.equal(loader.get('owner/target.js'), undefined, 'delete harus meng-unload dari registry (hot-reload)')
  const md2 = fakeM()
  await deleteHandler(md2, ctx('dp', 'owner-clearcache'))
  await assert.rejects(fs.stat(path.join(root, 'owner/owner-clearcache.js')))
  await assert.rejects(fs.stat(path.join(root, 'owner/clearcache.js')))
})

test('lp: semua, satu kategori, rentang abjad inklusif, dan multi kategori koma', async t => {
  const { root, loader } = await setup(t)
  for (const [name, tag] of [['satu', 'main'], ['dua', 'owner'], ['tiga', 'tools']]) await savePluginFile({ root, loader, name, code: code(tag) })
  const run = async text => { const m = fakeM(); await listHandler(m, { conn, text, args: text ? text.split(/\s+/) : [] }); return m.replies.at(-1) }
  const semua = await run('')
  for (const k of ['main', 'owner', 'tools']) assert.match(semua, new RegExp(`\\*${k}\\*`))
  const satu = await run('owner')
  assert.match(satu, /\*owner\*/); assert.doesNotMatch(satu, /\*tools\*/)
  const rentang = await run('main-owner')
  assert.match(rentang, /\*main\*/); assert.match(rentang, /\*owner\*/); assert.doesNotMatch(rentang, /\*tools\*/)
  const multi = await run('owner, main')
  assert.match(multi, /\*main\*/); assert.match(multi, /\*owner\*/); assert.doesNotMatch(multi, /\*tools\*/)
  await assert.rejects(run('ngawur'), /Kategori tidak ditemukan/)
})

test('gp: default teks, -f jadi file, teks >65000 jadi file', async t => {
  const { root, loader } = await setup(t)
  const sent = []
  const fileConn = { role: 'main', sendFile: async (...a) => { sent.push(a) } }
  const ctxF = (command, text) => ({ conn: fileConn, command, text, args: text ? text.split(/\s+/) : [] })
  const base = code('owner')
  const pad = (total) => `// ${'x'.repeat(total - base.length - 4)}\n${base}`
  await savePluginFile({ root, loader, name: 'kecil', code: base })
  await savePluginFile({ root, loader, name: 'sedang', code: pad(5000) })
  await savePluginFile({ root, loader, name: 'tepat', code: pad(65000) })
  await savePluginFile({ root, loader, name: 'besar', code: pad(65001) })
  assert.equal(pad(65000).length, 65000)
  assert.equal(pad(65001).length, 65001)

  // Default: teks — termasuk yang dulu (>3000 byte) dikirim sebagai file.
  const m1 = fakeM()
  await getHandler(m1, ctxF('gp', 'kecil'))
  assert.equal(m1.replies.at(-1), base)
  const m2 = fakeM()
  await getHandler(m2, ctxF('gp', 'sedang'))
  assert.equal(m2.replies.at(-1), pad(5000))
  assert.equal(sent.length, 0)

  // Batas: tepat 65000 masih teks.
  const m3 = fakeM()
  await getHandler(m3, ctxF('gp', 'tepat'))
  assert.equal(m3.replies.at(-1), pad(65000))
  assert.equal(sent.length, 0)

  // -f: file, tanpa balasan teks.
  const m4 = fakeM()
  await getHandler(m4, ctxF('gp', '-f kecil'))
  assert.equal(m4.replies.length, 0)
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], 'tes@s.whatsapp.net')
  assert.ok(Buffer.isBuffer(sent[0][1]))
  assert.equal(sent[0][2], 'kecil.js')
  assert.equal(sent[0][6].mimetype, 'text/javascript')

  // >65000 tanpa -f: otomatis file.
  const m5 = fakeM()
  await getHandler(m5, ctxF('gp', 'besar'))
  assert.equal(m5.replies.length, 0)
  assert.equal(sent.length, 2)
  assert.equal(sent[1][2], 'besar.js')

  // -f tanpa target: usage.
  await assert.rejects(getHandler(fakeM(), ctxF('gp', '-f')), /Gunakan \.gp \[-f\]/)
})
