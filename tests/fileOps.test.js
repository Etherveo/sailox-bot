import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createFileOps } from '../lib/helpers/fileOps.js'
import cdHandler from '../plugins/owner/cd.js'
import lsHandler from '../plugins/owner/ls.js'
import readfileHandler from '../plugins/owner/readfile.js'
import editfileHandler from '../plugins/owner/editfile.js'
import getfileHandler from '../plugins/owner/getfile.js'
import carifileHandler from '../plugins/owner/carifile.js'

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-fileops-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { root, ops: createFileOps({ root }) }
}

test('write/read/append: satu pintu fileOp untuk semua operasi dasar', async t => {
  const { ops } = await setup(t)
  await ops.fileOp('write', 'docs/a.txt', { data: 'halo' })
  assert.equal((await ops.fileOp('read', 'docs/a.txt', { as: 'text' })).data, 'halo')
  await assert.rejects(ops.fileOp('write', 'docs/a.txt', { data: 'timpa' }), /sudah ada/)
  await ops.fileOp('write', 'docs/a.txt', { data: 'timpa', overwrite: true })
  await ops.fileOp('append', 'docs/a.txt', { data: '!' })
  assert.equal((await ops.fileOp('read', 'docs/a.txt', { as: 'text' })).data, 'timpa!')
})

test('path jail: keluar root ditolak, absolut di dalam root diterima', async t => {
  const { root, ops } = await setup(t)
  await assert.rejects(ops.fileOp('read', '../kabur.txt', { as: 'text' }), /di luar root/)
  await assert.rejects(ops.fileOp('write', '/etc/jahat.txt', { data: 'x' }), /di luar root/)
  await ops.fileOp('write', path.join(root, 'dalam.txt'), { data: 'aman' })
  assert.equal((await ops.fileOp('read', 'dalam.txt', { as: 'text' })).data, 'aman')
})

test('sessions/ ditolak untuk semua action, termasuk lewat nomor urut', async t => {
  const { root, ops } = await setup(t)
  await fs.mkdir(path.join(root, 'sessions'), { recursive: true })
  await fs.writeFile(path.join(root, 'sessions', 'creds.json'), '{"rahasia":1}')
  await ops.fileOp('write', 'aaa.txt', { data: 'x' }) // entri lain agar nomor urut sessions bervariasi
  await assert.rejects(ops.fileOp('read', 'sessions/creds.json', { as: 'text' }), /sessions/)
  await assert.rejects(ops.fileOp('list', 'sessions'), /sessions/)
  await assert.rejects(ops.fileOp('remove', 'sessions'), /sessions/)
  const entries = (await ops.fileOp('list')).entries
  const idx = entries.findIndex(e => e.name === 'sessions') + 1
  assert.ok(idx >= 1)
  await assert.rejects(ops.fileOp('remove', String(idx)), /sessions/)
  assert.ok(await fs.stat(path.join(root, 'sessions', 'creds.json')), 'creds.json harus utuh')
})

test('node_modules hanya boleh dibaca, tidak boleh ditulis/dihapus', async t => {
  const { root, ops } = await setup(t)
  await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
  await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'module')
  assert.equal((await ops.fileOp('read', 'node_modules/pkg/index.js', { as: 'text' })).data, 'module')
  await assert.rejects(ops.fileOp('write', 'node_modules/pkg/baru.js', { data: 'x' }), /tidak boleh diubah/)
  await assert.rejects(ops.fileOp('remove', 'node_modules/pkg'), /tidak boleh diubah/)
})

test('list terurut folder-dulu dan nomor urut konsisten dengan list', async t => {
  const { ops } = await setup(t)
  await ops.fileOp('write', 'zeta.txt', { data: 'z' })
  await ops.fileOp('mkdir', 'alfa-dir')
  await ops.fileOp('write', 'beta.txt', { data: 'b' })
  const { entries } = await ops.fileOp('list')
  assert.deepEqual(entries.map(e => e.name), ['alfa-dir', 'beta.txt', 'zeta.txt'])
  assert.equal((await ops.fileOp('stat', '1')).type, 'dir')
  assert.equal((await ops.fileOp('read', '3', { as: 'text' })).data, 'z')
  await assert.rejects(ops.fileOp('stat', '9'), /tidak ada di daftar/)
})

test('edit: mode find/with menghitung penggantian, mode transform menjalankan fungsi konteks', async t => {
  const { ops } = await setup(t)
  await ops.fileOp('write', 'm.js', { data: 'sailox sailox' })
  const r1 = await ops.fileOp('edit', 'm.js', { find: 'sailox', with: 'ilok' })
  assert.equal(r1.replacements, 2)
  assert.equal((await ops.fileOp('read', 'm.js', { as: 'text' })).data, 'ilok ilok')
  // opts.transform = "param fleksibel yang mengeksekusi function" dari peminta:
  // helper membaca file, menjalankan fungsi ini, menulis hasilnya.
  const r2 = await ops.fileOp('edit', 'm.js', { transform: lama => lama.toUpperCase() })
  assert.equal(r2.changed, true)
  assert.equal((await ops.fileOp('read', 'm.js', { as: 'text' })).data, 'ILOK ILOK')
  await assert.rejects(ops.fileOp('edit', 'm.js', { find: 'tidakada', with: 'x' }), /tidak ditemukan/)
})

test('mkdir/remove/clear: root terlindungi, subfolder bebas', async t => {
  const { root, ops } = await setup(t)
  await ops.fileOp('mkdir', 'tmpkerja/sub')
  await assert.rejects(ops.fileOp('mkdir', 'tmpkerja'), /Sudah ada/)
  await ops.fileOp('write', 'tmpkerja/sub/f.txt', { data: 'x' })
  const cleared = await ops.fileOp('clear', 'tmpkerja')
  assert.equal(cleared.removed, 1)
  await assert.rejects(fs.stat(path.join(root, 'tmpkerja', 'sub')), /ENOENT/)
  assert.ok((await fs.stat(path.join(root, 'tmpkerja'))).isDirectory(), 'folder-nya sendiri tetap ada')
  await assert.rejects(ops.fileOp('clear', '.'), /tidak boleh dikosongkan/)
  await assert.rejects(ops.fileOp('remove', '.'), /tidak boleh dihapus/)
  await ops.fileOp('remove', 'tmpkerja')
  await assert.rejects(fs.stat(path.join(root, 'tmpkerja')), /ENOENT/)
})

test('copy & move: file dan folder, menolak tujuan yang sudah ada / ke dalam diri sendiri', async t => {
  const { root, ops } = await setup(t)
  await ops.fileOp('write', 'asal/f.txt', { data: 'isi' })
  const c1 = await ops.fileOp('copy', 'asal/f.txt', { to: 'tujuan/g.txt' })
  assert.equal(c1.rel, path.join('tujuan', 'g.txt'))
  assert.equal((await ops.fileOp('read', 'tujuan/g.txt', { as: 'text' })).data, 'isi')
  await ops.fileOp('copy', 'asal', { to: 'asal-copy' })
  assert.equal((await ops.fileOp('read', 'asal-copy/f.txt', { as: 'text' })).data, 'isi')
  await assert.rejects(ops.fileOp('copy', 'asal/f.txt', { to: 'tujuan/g.txt' }), /sudah ada/)
  await assert.rejects(ops.fileOp('copy', 'asal', { to: 'asal/dalam' }), /dirinya sendiri/)
  await ops.fileOp('move', 'tujuan/g.txt', { to: 'pindah.txt' })
  await assert.rejects(fs.stat(path.join(root, 'tujuan', 'g.txt')), /ENOENT/)
  await assert.rejects(ops.fileOp('move', 'pindah.txt', { to: 'asal/f.txt' }), /sudah ada/)
})

test('search: menemukan kata kunci, filter ekstensi, melewati node_modules & sessions', async t => {
  const { root, ops } = await setup(t)
  await ops.fileOp('write', 'src/a.js', { data: 'const x = "SailoxBot"' })
  await ops.fileOp('write', 'src/b.txt', { data: 'sailoxbot juga di sini' })
  await fs.mkdir(path.join(root, 'node_modules', 'p'), { recursive: true })
  await fs.writeFile(path.join(root, 'node_modules', 'p', 'c.js'), 'sailoxbot')
  await fs.mkdir(path.join(root, 'sessions'), { recursive: true })
  await fs.writeFile(path.join(root, 'sessions', 'creds.json'), 'sailoxbot')
  const all = await ops.fileOp('search', undefined, { query: 'SAILOXBOT' })
  assert.deepEqual(all.matches.map(m => m.rel).sort(), [path.join('src', 'a.js'), path.join('src', 'b.txt')])
  const jsOnly = await ops.fileOp('search', undefined, { query: 'sailoxbot', ext: '.js' })
  assert.deepEqual(jsOnly.matches.map(m => m.rel), [path.join('src', 'a.js')])
  assert.equal(jsOnly.matches[0].count, 1)
})

test('chdir: cwd virtual berpindah dan resolusi relatif mengikutinya', async t => {
  const { root, ops } = await setup(t)
  await ops.fileOp('mkdir', 'work')
  await ops.fileOp('chdir', 'work')
  await ops.fileOp('write', 'rel.txt', { data: 'di work' })
  assert.ok(await fs.stat(path.join(root, 'work', 'rel.txt')))
  await ops.fileOp('chdir', '..')
  assert.equal((await ops.fileOp('pwd')).path, root)
  await assert.rejects(ops.fileOp('chdir', '..'), /di luar root/)
  await assert.rejects(ops.fileOp('chdir', 'rel.txt'), /bukan direktori|tidak ditemukan/)
})

// --- Level perintah chat (plugin tipis -> fileCommands -> fileOps injeksi) ---
function fakeChat() {
  const replies = [], sent = []
  const conn = { role: 'main', sendMessage: async (chat, content) => { sent.push(content) } }
  const m = { chat: 'tes@s.whatsapp.net', reply: async teks => { replies.push(String(teks)) } }
  const ctx = (command, text = '') => ({ conn, command, text, args: text ? text.split(/\s+/) : [], usedPrefix: '.' })
  return { m, ctx, replies, sent }
}

async function setupChat(t) {
  const { root, ops } = await setup(t)
  global.fileOps = ops
  t.after(() => { delete global.fileOps })
  return { root, ops, ...fakeChat() }
}

test('plugin cd+ls+readfile: alur legacy berjalan di engine baru', async t => {
  const { ops, m, ctx, replies } = await setupChat(t)
  await ops.fileOp('write', 'docs/panduan.txt', { data: 'isi panduan' })
  await cdHandler(m, ctx('cd', 'docs'))
  assert.match(replies.at(-1), /Berhasil pindah/)
  await lsHandler(m, ctx('ls'))
  assert.match(replies.at(-1), /1\. 📄 panduan\.txt/)
  await readfileHandler(m, ctx('readfile', 'panduan.txt'))
  assert.equal(replies.at(-1), 'isi panduan')
  await cdHandler(m, ctx('cd'))
  assert.match(replies.at(-1), /Direktori sekarang/)
})

test('plugin editfile: format pipa legacy tetap berlaku', async t => {
  const { ops, m, ctx, replies } = await setupChat(t)
  await ops.fileOp('write', 'menu.js', { data: 'sailox dan sailox' })
  await editfileHandler(m, ctx('editfile', 'menu.js | sailox | ilok'))
  assert.match(replies.at(-1), /Diganti: 2x/)
  assert.equal((await ops.fileOp('read', 'menu.js', { as: 'text' })).data, 'ilok dan ilok')
})

test('plugin getfile mengirim dokumen & carifile menemukan isi', async t => {
  const { ops, m, ctx, replies, sent } = await setupChat(t)
  await ops.fileOp('write', 'data.json', { data: '{"kunci":"rahasia123"}' })
  await getfileHandler(m, ctx('getfile', 'data.json'))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].fileName, 'data.json')
  await carifileHandler(m, ctx('carifile', 'rahasia123'))
  assert.match(replies.at(-1), /data\.json/)
})

test('regex command plugin file tidak bertabrakan satu sama lain', () => {
  const cmds = { cd: cdHandler.command, ls: lsHandler.command, rf: readfileHandler.command, ef: editfileHandler.command, cf: carifileHandler.command }
  assert.match('cd', cmds.cd); assert.match('ls', cmds.ls); assert.match('dir', cmds.ls)
  assert.match('readfile', cmds.rf); assert.match('rf', cmds.rf)
  assert.match('editfile', cmds.ef); assert.match('ef', cmds.ef)
  assert.match('carifile', cmds.cf); assert.match('cf', cmds.cf)
  for (const word of ['cd', 'ls', 'rf', 'ef', 'cf']) {
    const hits = Object.entries(cmds).filter(([, re]) => re.test(word))
    assert.equal(hits.length, 1, `${word} harus cocok ke tepat satu plugin, kena: ${hits.map(h => h[0])}`)
  }
})

test('perintah file menolak sub-bot (jadibot)', async t => {
  const { m } = await setupChat(t)
  const ctxSub = { conn: { role: 'sub' }, command: 'ls', text: '', args: [], usedPrefix: '.' }
  await assert.rejects(lsHandler(m, ctxSub), /hanya untuk bot utama/)
})
