// tests/diskusage.test.js
// Port legacy plugins/owner-diskusage.js (.du): formatSize, scan rekursif,
// jail root project + tolak sessions/, dan handler plugin.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { formatSize } from '../lib/helpers/text.js'
import { resolveTarget, scanDir, diskUsage } from '../plugins/owner/diskusage.js'
import handler from '../plugins/owner/diskusage.js'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-du-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'a', 'b'), { recursive: true })
  await fs.writeFile(path.join(root, 'a', 'f1.txt'), '12345') // 5 B
  await fs.writeFile(path.join(root, 'a', 'b', 'f2.txt'), '1234567890') // 10 B
  await fs.writeFile(path.join(root, 'top.bin'), Buffer.alloc(100)) // 100 B
  return root
}

test('du: formatSize', () => {
  assert.equal(formatSize(0), '0 B')
  assert.equal(formatSize(500), '500.00 B')
  assert.equal(formatSize(1536), '1.50 KB')
  assert.equal(formatSize(5 * 1024 * 1024), '5.00 MB')
  assert.equal(formatSize(2 * 1024 ** 3), '2.00 GB')
})

test('du: scanDir menghitung ukuran + file + folder rekursif', async t => {
  const root = await fixture(t)
  const res = await scanDir(root)
  assert.equal(res.size, 115)
  assert.equal(res.files, 3)
  assert.equal(res.dirs, 2) // a, a/b
})

test('du: diskUsage file tunggal + direktori', async t => {
  const root = await fixture(t)
  const file = await diskUsage('top.bin', root)
  assert.equal(file.size, 100)
  assert.equal(file.files, 1)
  assert.equal(file.dirs, 0)
  assert.equal(file.isDirectory, false)
  const dir = await diskUsage('a', root)
  assert.equal(dir.size, 15)
  assert.equal(dir.files, 2)
  assert.equal(dir.dirs, 1)
  assert.equal(dir.isDirectory, true)
})

test('du: jail — keluar root, sessions/, dan symlink keluar ditolak', async t => {
  const root = await fixture(t)
  await assert.rejects(resolveTarget('../luar', root), /di luar root project/)
  await assert.rejects(resolveTarget('/etc', root), /di luar root project/)
  await assert.rejects(resolveTarget('sessions', root), /sessions/)
  await assert.rejects(resolveTarget('sessions/creds.json', root), /sessions/)
  await fs.mkdir(path.join(root, 'sessions'), { recursive: true })
  await assert.rejects(diskUsage('sessions', root), /sessions/)
  await assert.rejects(diskUsage('tidak-ada', root), /Path tidak ditemukan/)
  // Symlink keluar root ditolak meski namanya di dalam root.
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-du-out-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  await fs.symlink(outside, path.join(root, 'escape'))
  await assert.rejects(resolveTarget('escape', root), /keluar root project/)
})

test('du: handler — root, subpath, file, dan penolakan', async t => {
  const root = await fixture(t)
  global.pluginLoader = { root: path.join(root, 'plugins') }
  t.after(() => { delete global.pluginLoader })
  const conn = { sendMessage: async () => ({}) }
  const makeM = () => {
    const m = {
      chat: '123@s.whatsapp.net',
      sender: '123@s.whatsapp.net',
      key: { remoteJid: '123@s.whatsapp.net', id: 'msg1' },
      conn,
      replies: [],
      reply: async function (text) { this.replies.push(text) },
    }
    return m
  }
  const m = makeM()
  await handler(m, { conn, text: '' })
  assert.match(m.replies.at(-1), /Disk Usage/)
  assert.match(m.replies.at(-1), /Size: 115\.00 B/)
  assert.match(m.replies.at(-1), /Files: 3/)
  const m2 = makeM()
  await handler(m2, { conn, text: 'top.bin' })
  assert.match(m2.replies.at(-1), /Size: 100\.00 B/)
  const m3 = makeM()
  await assert.rejects(handler(m3, { conn, text: '../luar' }), /di luar root project/)
  const m4 = makeM()
  await assert.rejects(handler(m4, { conn, text: 'tidak-ada' }), /Path tidak ditemukan/)
  assert.equal(handler.owner, true)
  assert.match('du', handler.command)
  assert.match('diskusage', handler.command)
})

test('du: handler hanya bot utama', async () => {
  const sub = { sendMessage: async () => ({}) , role: 'sub' }
  const m = {
    chat: '123@s.whatsapp.net',
    key: { remoteJid: '123@s.whatsapp.net', id: 'msg1' },
    conn: sub,
    reply: async () => {},
  }
  await assert.rejects(handler(m, { conn: sub, text: '' }), /hanya untuk bot utama/)
})
