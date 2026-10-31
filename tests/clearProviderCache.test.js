// tests/clearProviderCache.test.js
//
// clearcache baru: sapu HANYA isi folder provider di src/downloads/.
// Folder provider dipertahankan, file lepas di root downloads tidak
// disentuh, symlink provider tidak diikuti, nama provider divalidasi.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ensureProviderDir, assertProviderName } from '../lib/helpers/ensureDir.js'
import {
  listProviderDirs,
  clearProviderDir,
  clearAllProviderDirs,
} from '../plugins/owner/clearcache.js'
import handler from '../plugins/owner/clearcache.js'

async function mkFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-clearcache-'))
  const dl = path.join(root, 'src', 'downloads')
  await fs.mkdir(path.join(dl, 'gofile', 'sub'), { recursive: true })
  await fs.mkdir(path.join(dl, 'tiktok'), { recursive: true })
  await fs.writeFile(path.join(dl, 'gofile', 'a.mp4'), '0123456789') // 10 byte
  await fs.writeFile(path.join(dl, 'gofile', 'sub', 'b.mp4'), '01234567890123456789') // 20 byte
  await fs.writeFile(path.join(dl, 'tiktok', 'c.mp4'), '01234') // 5 byte
  await fs.writeFile(path.join(dl, 'keep.txt'), 'lepas-di-root')
  // Target symlink di LUAR downloads — tidak boleh ikut tersapu.
  const outside = path.join(root, 'outside')
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(outside, 'jangan-hapus.txt'), 'x')
  await fs.symlink(outside, path.join(dl, 'linkprov'))
  return { root, dl, outside }
}

describe('clearProviderCache', () => {
  let fx
  beforeEach(async () => { fx = await mkFixture() })
  afterEach(async () => { await fs.rm(fx.root, { recursive: true, force: true }) })

  it('listProviderDirs hanya subdirektori asli, symlink dilewati', async () => {
    assert.deepEqual(await listProviderDirs(fx.root), ['gofile', 'tiktok'])
  })

  it('clearProviderDir mengosongkan isi, folder tetap ada, root tidak disentuh', async () => {
    const r = await clearProviderDir(fx.root, 'gofile')
    assert.equal(r.removed, 2)
    assert.equal(r.freedBytes, 30)
    assert.equal(r.missing, false)
    assert.deepEqual(await fs.readdir(path.join(fx.dl, 'gofile')), [])
    assert.ok((await fs.stat(path.join(fx.dl, 'gofile'))).isDirectory())
    assert.equal(await fs.readFile(path.join(fx.dl, 'tiktok', 'c.mp4'), 'utf8'), '01234')
    assert.equal(await fs.readFile(path.join(fx.dl, 'keep.txt'), 'utf8'), 'lepas-di-root')
  })

  it('clearAllProviderDirs menyapu semua provider, file root tetap', async () => {
    const results = await clearAllProviderDirs(fx.root)
    assert.deepEqual(results.map(r => r.provider), ['gofile', 'tiktok'])
    assert.deepEqual(await fs.readdir(path.join(fx.dl, 'gofile')), [])
    assert.deepEqual(await fs.readdir(path.join(fx.dl, 'tiktok')), [])
    assert.equal(await fs.readFile(path.join(fx.dl, 'keep.txt'), 'utf8'), 'lepas-di-root')
    assert.equal(await fs.readFile(path.join(fx.outside, 'jangan-hapus.txt'), 'utf8'), 'x')
  })

  it('provider yang tidak ada -> missing, bukan error', async () => {
    const r = await clearProviderDir(fx.root, 'tidakada')
    assert.equal(r.missing, true)
    assert.equal(r.removed, 0)
  })

  it('nama provider jahat ditolak (path traversal)', async () => {
    for (const bad of ['../evil', 'a/b', '..', '', '.hidden', 'a\\b']) {
      await assert.rejects(() => clearProviderDir(fx.root, bad), /tidak valid/)
    }
    assert.equal(assertProviderName('gofile'), 'gofile')
  })

  it('listProviderDirs di root downloads yang belum ada -> []', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-clearcache-empty-'))
    try {
      assert.deepEqual(await listProviderDirs(empty), [])
    } finally {
      await fs.rm(empty, { recursive: true, force: true })
    }
  })
})

describe('ensureProviderDir (validator folder provider)', () => {
  let root
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-provdir-')) })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

  it('membuat src/downloads/<provider> dan idempotent', async () => {
    const dir = await ensureProviderDir(root, 'gofile')
    assert.equal(dir, path.join(root, 'src', 'downloads', 'gofile'))
    assert.ok((await fs.stat(dir)).isDirectory())
    assert.equal(await ensureProviderDir(root, 'gofile'), dir)
  })

  it('menolak nama provider jahat', async () => {
    for (const bad of ['../evil', 'a/b', '..', '']) {
      await assert.rejects(() => ensureProviderDir(root, bad), /tidak valid/)
    }
  })
})

describe('plugin clearcache', () => {
  let fx
  beforeEach(async () => { fx = await mkFixture() })
  afterEach(async () => { await fs.rm(fx.root, { recursive: true, force: true }) })

  function fakeCtx(args) {
    const replies = []
    const reacts = []
    const conn = { sendMessage: async () => { reacts.push(1) } }
    const m = {
      key: { remoteJid: '6282348181097@s.whatsapp.net', id: 'MSG1' },
      conn,
      reply: async (text) => { replies.push(String(text)); return text },
    }
    // projectRoot plugin: global.pluginLoader kosong di tes, jadi pakai
    // __dirname palsu -> root = tmp fixture.
    const ctx = {
      conn,
      args,
      usedPrefix: '.',
      command: 'clearcache',
      __dirname: path.join(fx.root, 'plugins', 'owner'),
    }
    return { m, ctx, replies, reacts }
  }

  it('handler.owner = true (bukan typo rowner legacy)', () => {
    assert.equal(handler.owner, true)
    assert.equal(handler.rowner, undefined)
  })

  it('tanpa argumen -> usage + daftar provider', async () => {
    const { m, ctx, replies } = fakeCtx([])
    await handler(m, ctx)
    assert.match(replies[0], /Clear Cache/)
    assert.match(replies[0], /gofile/)
    assert.match(replies[0], /tiktok/)
  })

  it('.clearcache all menyapu isi semua provider', async () => {
    const { m, ctx, replies } = fakeCtx(['all'])
    await handler(m, ctx)
    assert.match(replies[0], /Dibersihkan/)
    assert.match(replies[0], /gofile/)
    assert.match(replies[0], /tiktok/)
    assert.deepEqual(await fs.readdir(path.join(fx.dl, 'gofile')), [])
    assert.deepEqual(await fs.readdir(path.join(fx.dl, 'tiktok')), [])
    assert.equal(await fs.readFile(path.join(fx.dl, 'keep.txt'), 'utf8'), 'lepas-di-root')
  })

  it('provider tidak dikenal -> dilewati, bukan error', async () => {
    const { m, ctx, replies } = fakeCtx(['ngawur'])
    await handler(m, ctx)
    assert.match(replies[0], /Dilewati/)
    assert.match(replies[0], /ngawur/)
  })
})
