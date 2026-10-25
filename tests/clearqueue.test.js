import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createDownloadQueue } from '../lib/downloader/queue.js'
import handler from '../plugins/owner/clearqueue.js'

async function tmpQueue(processJob = () => new Promise(() => {})) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cq-'))
  const q = createDownloadQueue({ file: path.join(dir, 'q.json'), processJob })
  return { dir, q }
}

const job = (url, sender) => ({ url, provider: 'tiktok', chat: 'chat1', sender })

// Pump mengklaim secara asinkron lewat rantai tulis; tunggu sampai file
// antrean benar-benar mencerminkan status yang diharapkan.
async function waitFor(q, pred, label) {
  for (let i = 0; i < 200; i++) {
    const s = await q.snapshot()
    if (pred(s)) return s
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`timeout menunggu: ${label}`)
}

// ─── clearQueue ──────────────────────────────────────────────────────────

test('clearQueue: hapus pending + klaim manual + cooldown, biarkan aktif, seq jalan terus', async () => {
  const { q } = await tmpQueue()
  // Pengirim berbeda per job supaya batas pending per pengguna tidak ikut
  // menghalangi penyiapan; 2 job pertama jadi aktif (maxConcurrent 2,
  // processJob menggantung), sisanya menunggu.
  const a = await q.enqueue(job('https://x.test/a', 'userA'))
  const b = await q.enqueue(job('https://x.test/b', 'userB'))
  await waitFor(q, s => s.jobs.filter(j => j.status === 'active').length === 2, '2 job aktif')
  // 1 pending biasa + 1 klaim manual (.tt) tetap menunggu.
  await q.enqueue(job('https://x.test/c', 'userC'))
  await q.enqueue({ ...job('https://x.test/d', 'userD'), manual: true })
  // 1 cooldown: job selesai -> masuk recent.
  const e = await q.enqueue(job('https://x.test/e', 'userE'))
  await q.finish(e.job.id, { status: 'done' })
  // Link yang baru selesai masih ditolak selama cooldown.
  await assert.rejects(() => q.enqueue(job('https://x.test/e', 'userE')), /baru saja diproses/)

  const r = await q.clearQueue()
  assert.equal(r.active, 2)
  assert.equal(r.pending, 1)
  assert.equal(r.manual, 1)
  assert.equal(r.recent, 1)
  assert.equal(r.cleared, 2)

  const snap = await q.snapshot()
  assert.equal(snap.jobs.length, 2)
  assert.ok(snap.jobs.every(j => j.status === 'active'))
  // Cooldown hilang: link yang sama bisa dites lagi; seq tidak direset.
  const again = await q.enqueue(job('https://x.test/e', 'userE'))
  assert.ok(again.job.id > e.job.id)
  void a; void b
})

test('clearQueue: antrean kosong -> semua nol', async () => {
  const { q } = await tmpQueue()
  assert.deepEqual(await q.clearQueue(), { pending: 0, manual: 0, recent: 0, active: 0, cleared: 0 })
})

// ─── handler ─────────────────────────────────────────────────────────────

test('handler .cq: pakai antrean dari ctx, laporkan hitungan', async () => {
  const replies = []
  const m = { reply: async t => { replies.push(t) } }
  const stub = { clearQueue: async () => ({ pending: 2, manual: 1, recent: 3, active: 1, cleared: 3 }) }
  await handler(m, { downloadQueue: stub })
  const text = replies.join('\n')
  assert.match(text, /2 job menunggu/)
  assert.match(text, /1 klaim manual/)
  assert.match(text, /3 cooldown/)
  assert.match(text, /1 job aktif dibiarkan/)
})

test('handler .cq: metadata perintah owner', () => {
  assert.ok(handler.command.test('cq'))
  assert.ok(handler.command.test('clearqueue'))
  assert.ok(!handler.command.test('cqx'))
  assert.equal(handler.founder, true)
  assert.deepEqual(handler.tags, ['owner'])
  assert.deepEqual(handler.help, ['clearqueue'])
})
