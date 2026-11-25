// tests/animeDisabled.test.js — fitur anime Kuramanime dimatikan
// sementara (keputusan Veo 2026-11-25): .ongoing/.carianime/.anime/
// .pilih membalas "Fitur ini sedang dimatikan sementara." dan tidak
// makan limit, untuk semua orang termasuk founder/owner. .adl TIDAK
// disentuh (link langsung, bukan Kuramanime) — tes di sini mengunci
// bahwa ia tetap aktif.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPluginLoader } from '../lib/plugins/loader.js'
import { createPipeline } from '../lib/plugins/pipeline.js'
import { Database } from '../lib/database/engine.js'
import { fakeConn, raw, PN, LID } from './fixtures.js'
import { dayKey } from '../lib/helpers/time.js'

const ANIME = ['anime/ongoing.js', 'anime/carianime.js', 'anime/anime.js', 'anime/pilih.js']

async function loadReal(t) {
  const loader = createPluginLoader({ root: path.resolve('plugins'), publish: false, watch: false, onError: e => { throw e } })
  await loader.load()
  t.after(() => loader.close())
  return loader
}

async function setup(t, entries) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-animeoff-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const db = await new Database({ dir: root }).load()
  global.db = db
  const prevLimit = global.defaultLimit
  global.defaultLimit = 50
  t.after(() => { global.defaultLimit = prevLimit })
  const conn = fakeConn({ db })
  const loader = { root, list: () => entries }
  const pipeline = createPipeline({ db, plugins: loader, config: { prefix: '.', cooldownMs: 0, maxMessageAgeSec: 120 }, log: () => {}, error: () => {} })
  const run = messages => pipeline.handler.call(conn, { type: 'notify', messages })
  t.after(async () => { await pipeline.close(); await conn.store.close() })
  for (const jid of [PN, LID]) { const u = db.ensure('users', jid); u.registered = true; u.limitDay = dayKey(Date.now(), 'Asia/Jakarta'); u.limit = 50 }
  for (const jid of [PN, LID]) db.ensure('chats', jid).isBanned = false
  const texts = () => conn.calls.filter(c => c.data?.text != null).map(c => c.data.text)
  return { db, conn, pipeline, run, user: () => db.data.users[LID], texts }
}

test('anime dimatikan: keempat plugin alur Kuramanime memasang handler.disabled', async t => {
  const loader = await loadReal(t)
  for (const id of ANIME) {
    const entry = loader.list().find(e => e.id === id)
    assert.ok(entry, `${id} harus ada`)
    assert.equal(entry.plugin.disabled, true, `${id} harus disabled`)
    assert.equal(entry.plugin.limit, true, `${id} tetap ber-limit (invarian pluginLimits)`)
  }
})

test('anime dimatikan: .adl tidak dimatikan (link langsung, bukan Kuramanime)', async t => {
  const loader = await loadReal(t)
  const entry = loader.list().find(e => e.id === 'downloader/animedownload.js')
  assert.ok(entry, 'plugins/downloader/animedownload.js harus ada')
  assert.equal(entry.plugin.disabled, undefined, '.adl memakai link langsung — jangan dimatikan')
  assert.equal(entry.plugin.command.test('adl'), true)
})

test('anime dimatikan: .ongoing/.carianime/.anime/.pilih dibalas "dimatikan sementara" tanpa makan limit', async t => {
  const loader = await loadReal(t)
  const entries = ANIME.map(id => loader.list().find(e => e.id === id))
  assert.ok(entries.every(Boolean), 'keempat plugin harus termuat')
  const { run, user, texts } = await setup(t, entries)
  await run([raw('.ongoing', { id: 'a1' })])
  await run([raw('.carianime test', { id: 'a2' })])
  await run([raw('.anime https://kuramanime.example/x', { id: 'a3' })])
  await run([raw('.pilih 1', { id: 'a4' })])
  assert.equal(user().limit, 50, 'limit tidak boleh terpotong')
  const replies = texts()
  assert.equal(replies.length, 4, 'setiap perintah dibalas sekali: ' + JSON.stringify(replies))
  for (const r of replies) assert.match(r, /dimatikan sementara/, r)
})

test('anime dimatikan: berlaku juga untuk founder/owner', async t => {
  global.founder = [['6281234567890', 'Founder']]
  t.after(() => { delete global.founder })
  const loader = await loadReal(t)
  const entries = ANIME.map(id => loader.list().find(e => e.id === id))
  const { run, user, texts } = await setup(t, entries)
  await run([raw('.ongoing', { id: 'a5' })])
  assert.equal(user().limit, 50, 'limit founder/owner juga tidak boleh terpotong')
  assert.ok(texts().some(x => /dimatikan sementara/.test(x)), texts())
})

test('anime dimatikan: handler.before plugin yang dimatikan juga tidak jalan', async t => {
  let beforeRan = false
  let ran = false
  const p = async () => { ran = true }
  p.help = ['pilih <nomor>']; p.tags = ['anime']; p.command = /^pilih$/i
  p.limit = true; p.disabled = true
  p.before = () => { beforeRan = true; return true }
  const { run, conn } = await setup(t, [{ id: 'anime/pilih.js', plugin: p }])
  await run([raw('1', { id: 'a6' })])
  assert.equal(beforeRan, false, 'before hook plugin disabled tidak boleh jalan')
  assert.equal(ran, false, 'handler plugin disabled tidak boleh jalan')
  assert.equal(conn.calls.filter(c => c.data).length, 0, 'tidak ada balasan apa pun')
})
