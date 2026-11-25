import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Database } from '../lib/database/engine.js'
import { createPipeline } from '../lib/plugins/pipeline.js'
import { raw, fakeConn, LID, PN, GROUP } from './fixtures.js'
import stickerHandler from '../plugins/sticker/sticker.js'

// Aturan Veo 2026-11-25 (DM .ryn 08:51): eror beneran -> raw error ke
// owner, sender hanya pesan generik; pelanggaran kebijakan -> sender
// diberi tahu eksplisit aturannya, TANPA laporan error ke owner.
// Pipeline membedakan keduanya dari jenis throw: string = kebijakan,
// Error = eror beneran (lib/plugins/pipeline.js, blok catch dispatch).
async function setup(t, entries = [], extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-err-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const db = await new Database({ dir }).load()
  const conn = fakeConn({ db })
  global.db = db
  for (const jid of [PN, LID]) db.ensure('users', jid).registered = true
  for (const jid of [PN, LID, GROUP]) db.ensure('chats', jid).isBanned = false
  const errors = []
  const config = { prefix: '.', maxMessageAgeSec: 120, cooldownMs: 0, ...extra }
  const loader = { root: dir, list: () => entries.map(([id, plugin]) => ({ id, plugin })) }
  const pipeline = createPipeline({ db, plugins: loader, config, log: () => {}, error: e => errors.push(e) })
  const run = messages => pipeline.handler.call(conn, { type: 'notify', messages })
  t.after(async () => { await pipeline.close(); await conn.store.close() })
  return { db, conn, pipeline, run, errors }
}
const plugin = (fn, props = {}) => Object.assign(fn, { command: /^boom$/, ...props })

test('string throw (kebijakan): sender dapat pesan apa adanya, owner TIDAK dapat laporan', async t => {
  global.founder = [['6281234567890', 'Founder']]
  t.after(() => { delete global.founder })
  const policy = plugin(async () => { throw 'Maksimal durasi hanya 10 detik' }, { command: /^kebijakan$/ })
  const { run, conn } = await setup(t, [['kebijakan.js', policy]], { founder: [['6281234567890', 'Founder']] })
  await run([raw('halo', { id: 'opener' })]) // founder pernah menghubungi bot
  conn.calls.length = 0
  await run([raw('.kebijakan', { id: 'k1' })])
  const replies = conn.calls.filter(c => c.data)
  assert.equal(replies.length, 1, 'hanya satu balasan ke sender')
  assert.equal(replies[0].jid, PN)
  assert.equal(replies[0].data.text, 'Maksimal durasi hanya 10 detik')
  assert.ok(!conn.calls.some(c => /kebijakan\.js/.test(c.data?.text || '')), 'tidak ada laporan error ke founder')
})

test('Error throw (eror beneran): sender dapat generik, owner dapat laporan raw', async t => {
  global.founder = [['6281234567890', 'Founder']]
  t.after(() => { delete global.founder })
  const failing = plugin(async () => { throw new Error('rahasia internal xyz') }, { command: /^boom$/ })
  const { run, conn } = await setup(t, [['boom.js', failing]], { founder: [['6281234567890', 'Founder']] })
  await run([raw('halo', { id: 'opener' })])
  conn.calls.length = 0
  await run([raw('.boom', { id: 'b1' })])
  const toSender = conn.calls.find(c => c.jid === PN && c.data && !/boom\.js/.test(c.data.text || ''))
  assert.ok(toSender, 'sender dibalas')
  assert.equal(toSender.data.text, 'Terjadi kesalahan. Coba lagi nanti.')
  assert.ok(!toSender.data.text.includes('rahasia'), 'pesan generik tidak membocorkan detail')
  const report = conn.calls.find(c => c.jid === PN && /boom\.js/.test(c.data?.text || ''))
  assert.ok(report, 'laporan raw terkirim ke founder')
  assert.match(report.data.text, /rahasia internal xyz/)
})

// Kasus pemicu (Veo 2026-11-25 08:51): .s pada video 17 detik (maks 10).
// Dulu: owner dapat "Plugin sticker/sticker.js; command s: Error: Durasi
// video 17 detik — harus di bawah 10 detik." sementara sender hanya dapat
// pesan generik. Sekarang sender langsung dapat pesan durasinya.
test('.s video 17 detik: sender dapat pesan durasi eksplisit, bukan generik', async t => {
  global.founder = [['6281234567890', 'Founder']]
  t.after(() => { delete global.founder })
  const { run, conn } = await setup(t, [['sticker/sticker.js', stickerHandler]], { founder: [['6281234567890', 'Founder']] })
  await run([raw('halo', { id: 'opener' })])
  conn.calls.length = 0
  const video = raw('.s', { id: 's17', message: { videoMessage: { caption: '.s', seconds: 17, fileLength: 1000 } } })
  await run([video])
  const replies = conn.calls.filter(c => c.data)
  assert.equal(replies.length, 1, 'hanya satu balasan ke sender')
  assert.equal(replies[0].data.text, 'Durasi video 17 detik — harus di bawah 10 detik.')
  assert.ok(!conn.calls.some(c => /sticker\/sticker\.js/.test(c.data?.text || '')), 'tidak ada laporan error ke founder')
})
