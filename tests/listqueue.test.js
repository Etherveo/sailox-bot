import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createDownloadQueue } from '../lib/downloader/queue.js'
import handler from '../plugins/owner/listqueue.js'

// ─── snapshot().recent ───────────────────────────────────────────────────

test('snapshot: finish menambahkan cooldown yang terlihat di snapshot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lq-'))
  const file = path.join(dir, 'q.json')
  const q = createDownloadQueue({ file, processJob: async () => ({}) })
  const { job } = await q.enqueue({ url: 'https://x.test/a', provider: 'tiktok', chat: 'c', sender: 'u' })
  await q.finish(job.id, { status: 'done' })
  const snap = await q.snapshot()
  assert.equal(snap.recent.length, 1)
  assert.equal(snap.recent[0].url, 'https://x.test/a')
})

test('snapshot: membuang cooldown kedaluwarsa (file ditulis dulu, instance baru)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lq-'))
  const file = path.join(dir, 'q.json')
  // File ditulis SEBELUM instance dibuat, jadi tidak ada pump yang bisa
  // menimpa ulang isinya di tengah tes.
  await fs.writeFile(file, JSON.stringify({ seq: 0, jobs: [], recent: [
    { url: 'https://x.test/old', until: Date.now() - 1000 },
    { url: 'https://x.test/new', until: Date.now() + 60_000 },
  ] }))
  const q = createDownloadQueue({ file, processJob: async () => ({}) })
  const snap = await q.snapshot()
  assert.deepEqual(snap.recent.map(r => r.url), ['https://x.test/new'])
})

// ─── handler ─────────────────────────────────────────────────────────────

test('handler .lq: daftar job + cooldown, tanpa JID pengirim', async () => {
  const replies = []
  const m = { reply: async t => { replies.push(t) } }
  const now = Date.now()
  const stub = {
    snapshot: async () => ({
      jobs: [
        { id: 1, url: 'https://x.test/a', provider: 'tiktok', sender: '628xx@s.whatsapp.net', senderName: 'Veo', status: 'active', manual: false },
        { id: 2, url: 'https://x.test/b', provider: 'instagram', sender: '628yy@s.whatsapp.net', senderName: '', status: 'pending', manual: true },
      ],
      pending: 1,
      active: 1,
      recent: [{ url: 'https://x.test/c', until: now + 45_000 }],
    }),
  }
  await handler(m, { downloadQueue: stub })
  const text = replies.join('\n')
  assert.match(text, /Sedang berjalan: 1 • Menunggu: 1/)
  assert.match(text, /#1 — .* — sedang diunduh — Veo — https:\/\/x\.test\/a/)
  assert.match(text, /#2 — .* — menunggu \[klaim \.tt\] — https:\/\/x\.test\/b/)
  assert.match(text, /Cooldown \(1\):/)
  assert.match(text, /https:\/\/x\.test\/c \(4\d detik lagi\)/)
  assert.ok(!text.includes('628xx') && !text.includes('628yy'))
})

test('handler .lq: antrean kosong', async () => {
  const replies = []
  const m = { reply: async t => { replies.push(t) } }
  await handler(m, { downloadQueue: { snapshot: async () => ({ jobs: [], pending: 0, active: 0, recent: [] }) } })
  assert.match(replies.join('\n'), /Antrean kosong\./)
})

test('handler .lq: metadata perintah owner', () => {
  assert.ok(handler.command.test('lq'))
  assert.ok(handler.command.test('listqueue'))
  assert.ok(!handler.command.test('lqx'))
  assert.equal(handler.founder, true)
  assert.deepEqual(handler.tags, ['owner'])
  assert.deepEqual(handler.help, ['listqueue'])
})
