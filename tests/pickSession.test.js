// tests/pickSession.test.js — sesi pilih interaktif GoFile (.dl list ->
// angka/all/lanjut/batal), job batch sekuensial, dan aturan antrean
// sessionPick. .tt dan Pixeldrain sengaja TIDAK disentuh fitur ini.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createDownloadQueue } from '../lib/downloader/queue.js'
import { runDownloadJob } from '../lib/downloader/runJob.js'
import { createPickSessionStore } from '../lib/helpers/pickSession.js'
import pickHandler from '../plugins/downloader/pick.js'

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-pick-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

// ─── Store ──────────────────────────────────────────────────────────────────

test('pickSession: put/get, kedaluwarsa malas, touch memperpanjang, delete', () => {
  let nowVal = 1000
  const store = createPickSessionStore({ ttlMs: 1000, now: () => nowVal })
  store.put('c', 'A', { provider: 'gofile', baseUrl: 'u', items: [] })
  assert.equal(store.get('c', 'A')?.provider, 'gofile')
  assert.equal(store.get('c', 'B'), null, 'sender lain tidak ikut')
  assert.equal(store.get('d', 'A'), null, 'chat lain tidak ikut')
  nowVal = 1500
  store.touch('c', 'A')
  nowVal = 2400
  assert.ok(store.get('c', 'A'), 'touch memperpanjang TTL dari saat touch')
  nowVal = 2600
  assert.equal(store.get('c', 'A'), null, 'kedaluwarsa malas: dianggap tidak ada')
  store.put('c', 'A', { provider: 'gofile', baseUrl: 'u', items: [] })
  store.delete('c', 'A')
  assert.equal(store.get('c', 'A'), null)
})

// ─── Antrean: sessionPick ───────────────────────────────────────────────────

test('antrean: sessionPick melewati cooldown tapi tetap kena dedupe saat mengantri', async t => {
  const dir = await tmpDir(t)
  const queue = createDownloadQueue({ file: path.join(dir, 'q.json'), processJob: async () => ({}) })
  const { job } = await queue.enqueue({ url: 'https://gofile.io/d/abc', provider: 'gofile', chat: 'c', sender: 'A' })
  await queue.finish(job.id, { status: 'done' })
  await assert.rejects(queue.enqueue({ url: 'https://gofile.io/d/abc', provider: 'gofile', chat: 'c', sender: 'A' }), /baru saja diproses/)
  await queue.enqueue({ url: 'https://gofile.io/d/abc', provider: 'gofile', chat: 'c', sender: 'A', sessionPick: true })
  // Tunggu pump menghabiskan job sessionPick (manual tidak diproses pump).
  const manual = await queue.enqueue({ url: 'https://gofile.io/d/live', provider: 'gofile', chat: 'c', sender: 'A', manual: true })
  assert.equal(manual.job.manual, true)
  await assert.rejects(queue.enqueue({ url: 'https://gofile.io/d/live', provider: 'gofile', chat: 'c', sender: 'A', sessionPick: true }), /sudah ada di antrean/)
  for (let i = 0; i < 200; i++) {
    const snap = await queue.snapshot()
    if (snap.active === 0 && snap.jobs.every(j => j.manual)) break
    await new Promise(r => setTimeout(r, 10))
  }
  const snap = await queue.snapshot()
  assert.equal(snap.active, 0, 'tidak ada job aktif tertinggal saat tes selesai')
  assert.ok(snap.jobs.every(j => j.manual), 'hanya klaim manual yang tersisa')
})

test('antrean: update() menambal field job yang masih hidup', async t => {
  const dir = await tmpDir(t)
  const queue = createDownloadQueue({ file: path.join(dir, 'q.json'), processJob: async () => ({}) })
  const { job } = await queue.enqueue({ url: 'https://gofile.io/d/abc', provider: 'gofile', chat: 'c', sender: 'A', batch: { name: 'F', items: [], progress: { done: [], failed: [], kept: [] } } })
  await queue.update(job.id, { batch: { name: 'F', items: [], progress: { done: [0], failed: [], kept: [] } } })
  const snap = await queue.snapshot()
  assert.deepEqual(snap.jobs.find(j => j.id === job.id).batch.progress.done, [0])
})

// ─── runJob: list GoFile membuka sesi, Pixeldrain tetap pola lama ──────────

function listEngine(files) {
  return {
    getInfo: async url => {
      if (url.includes('#item=')) {
        const n = Number(url.split('#item=')[1])
        const f = files[n - 1]
        return { fileName: f.fileName, size: f.size, mimetype: 'video/mp4', downloadUrl: `https://file/${n}` }
      }
      return { isList: true, fileName: 'Folderku', size: files.reduce((a, f) => a + f.size, 0), files }
    },
    download: async (url, info, { destDir, baseName }) => {
      const fileName = `${baseName}.mp4`
      const filePath = path.join(destDir, fileName)
      await fs.writeFile(filePath, 'x'.repeat(info.size ?? 5))
      return { filePath, fileName, mimetype: 'video/mp4', size: info.size ?? 5 }
    },
  }
}

function fakeConn(events) {
  return {
    sendMessage: async (chat, content) => { events.push(content) },
    sendFile: async (chat, filePath, fileName, caption, quoted, ptt, options) => { events.push({ file: fileName, filePath, options }) },
  }
}

const FILES = [
  { fileName: 'satu.mp4', size: 10 },
  { fileName: 'dua.mp4', size: 20 },
  { fileName: 'tiga.mp4', size: 30 },
]

test('runJob: list GoFile + pickSession membuka sesi dan prompt angka/all/batal', async t => {
  const dir = await tmpDir(t)
  const events = []
  const store = createPickSessionStore()
  const registry = { getEngine: () => listEngine(FILES) }
  const job = { id: 9, url: 'https://gofile.io/d/abc', provider: 'gofile', chat: 'c', sender: 'A', options: { pickSession: true } }
  const result = await runDownloadJob({ conn: fakeConn(events), job, registry, rootDir: dir, waMaxBytes: 25, pickStore: store })
  assert.equal(result.kind, 'list')
  const session = store.get('c', 'A')
  assert.ok(session, 'sesi dibuat')
  assert.equal(session.items.length, 3)
  assert.equal(session.baseUrl, 'https://gofile.io/d/abc')
  const prompt = events.find(e => typeof e.text === 'string')?.text ?? ''
  assert.match(prompt, /1\. satu\.mp4/)
  assert.match(prompt, /3\. tiga\.mp4 — .*melebihi batas WA/, 'item oversized ditandai')
  assert.match(prompt, /\*all\*/)
  assert.match(prompt, /\*batal\*/)
  assert.ok(!events.some(e => e.file), 'tidak ada unduhan saat list')
})

test('runJob: list Pixeldrain tanpa pickSession tetap teks #item lama', async t => {
  const dir = await tmpDir(t)
  const events = []
  const store = createPickSessionStore()
  const registry = { getEngine: () => listEngine(FILES) }
  const job = { id: 10, url: 'https://pixeldrain.com/l/abc', provider: 'pixeldrain', chat: 'c', sender: 'A' }
  const result = await runDownloadJob({ conn: fakeConn(events), job, registry, rootDir: dir, pickStore: store })
  assert.equal(result.kind, 'list')
  assert.equal(store.get('c', 'A'), null, 'tidak ada sesi untuk Pixeldrain')
  assert.match(events.find(e => typeof e.text === 'string').text, /#item=<nomor>/)
})

// Regresi 2026-10-25: info item terpilih GoFile membawa isList +
// itemIndex (untuk baris "Item ke-N dari M") TAPI tanpa array files —
// cabang list lama (isList && !fileUrl) salah menangkapnya sebagai list
// beneran, info.files undefined melempar, job hilang diam-diam tanpa
// pesan apa pun (kasus .dl gofile #item=1). Syarat cabang kini menuntut
// tidak ada downloadUrl juga.
test('runJob: pick GoFile #item (isList tanpa files) mengalir single, bukan list', async t => {
  const dir = await tmpDir(t)
  const events = []
  const store = createPickSessionStore()
  const engine = {
    getInfo: async url => {
      if (url.includes('#item=')) {
        return { isList: true, itemIndex: 1, listSize: 4, fileName: 'satu.mp4', size: 10, mimetype: 'video/mp4', downloadUrl: 'https://file/satu' }
      }
      return { isList: true, fileName: 'Folderku', size: 100, files: FILES }
    },
    download: async (url, info, { destDir, baseName }) => {
      const fileName = `${baseName}.mp4`
      const filePath = path.join(destDir, fileName)
      await fs.writeFile(filePath, 'x'.repeat(10))
      return { filePath, fileName, mimetype: 'video/mp4', size: 10 }
    },
  }
  const registry = { getEngine: () => engine }
  const job = { id: 11, url: 'https://gofile.io/d/abc#item=1', provider: 'gofile', chat: 'c', sender: 'A', options: { pickSession: true } }
  const result = await runDownloadJob({ conn: fakeConn(events), job, registry, rootDir: dir, pickStore: store })
  assert.equal(result.kind, 'file')
  assert.equal(store.get('c', 'A'), null, 'pick tidak membuka sesi baru')
  const infoText = events.find(e => typeof e.text === 'string' && /Informasi File/.test(e.text))?.text ?? ''
  assert.match(infoText, /Item ke-1 dari 4 di list/)
  assert.ok(events.some(e => e.file === 'satu.mp4'), 'file terkirim')
})

// Video single dikirim sebagai dokumen (asDocument), foto tidak —
// perilaku yang pemilik minta 2026-10-25 (mp4 GoFile terkirim sebagai
// video padahal maunya dokumen seperti alur kuramanime lama).
test('runJob: single video → asDocument, single foto → tanpa asDocument', async t => {
  const dir = await tmpDir(t)
  const mkEngine = (fileName, mimetype) => ({
    getInfo: async () => ({ fileName, size: 10, mimetype, downloadUrl: 'https://file/x' }),
    download: async (url, info, { destDir, baseName }) => {
      const filePath = path.join(destDir, fileName)
      await fs.writeFile(filePath, 'x'.repeat(10))
      return { filePath, fileName, mimetype, size: 10 }
    },
  })
  const eventsV = []
  await runDownloadJob({ conn: fakeConn(eventsV), job: { id: 21, url: 'https://gofile.io/d/abc#item=1', provider: 'gofile', chat: 'c', sender: 'A' }, registry: { getEngine: () => mkEngine('ep.mp4', 'video/mp4') }, rootDir: dir, pickStore: createPickSessionStore() })
  assert.equal(eventsV.find(e => e.file === 'ep.mp4')?.options?.asDocument, true, 'mp4 dikirim sebagai dokumen')
  const eventsI = []
  await runDownloadJob({ conn: fakeConn(eventsI), job: { id: 22, url: 'https://x.test/foto.jpg', provider: 'pixeldrain', chat: 'c', sender: 'A' }, registry: { getEngine: () => mkEngine('foto.jpg', 'image/jpeg') }, rootDir: dir, pickStore: createPickSessionStore() })
  assert.equal(eventsI.find(e => e.file === 'foto.jpg')?.options?.asDocument, undefined, 'foto tetap image')
})

// ─── runJob: batch ──────────────────────────────────────────────────────────

test('runJob: batch all kirim berurutan, hapus per item, progres tercatat', async t => {
  const dir = await tmpDir(t)
  const events = []
  const patches = []
  const registry = { getEngine: () => listEngine(FILES) }
  const job = {
    id: 5, url: 'https://gofile.io/d/abc', provider: 'gofile', chat: 'c', sender: 'A',
    sessionPick: true, userMsgKey: { id: 'allmsg' },
    batch: { name: 'Folderku', items: FILES.map((f, i) => ({ index: i, ...f })), progress: { done: [], failed: [], kept: [] } },
  }
  const result = await runDownloadJob({ conn: fakeConn(events), job, registry, rootDir: dir, updateJob: async (id, patch) => { patches.push(patch) } })
  assert.equal(result.kind, 'batch')
  const sent = events.filter(e => e.file).map(e => e.file)
  assert.deepEqual(sent, ['satu.mp4', 'dua.mp4', 'tiga.mp4'], 'urutan kirim = urutan item')
  assert.ok(events.filter(e => e.file).every(e => e.options?.asDocument === true), 'video batch dikirim sebagai dokumen')
  assert.match(events.find(e => typeof e.text === 'string' && /Batch/.test(e.text)).text, /3 dari 3 file terkirim/)
  const lastProgress = patches.at(-1).batch.progress
  assert.deepEqual(lastProgress.done, [0, 1, 2])
  const leftovers = await fs.readdir(path.join(dir, 'src', 'downloads', 'gofile')).catch(() => [])
  assert.deepEqual(leftovers, [], 'folder batch dibersihkan bila semua terkirim')
  assert.ok(events.some(e => e.react?.text === '✅'), 'react ✅ di pesan all')
})

test('runJob: batch oversized + gagal dilanjutkan dari progres (resume)', async t => {
  const dir = await tmpDir(t)
  let failSecond = true
  const engine = listEngine(FILES)
  const origDownload = engine.download
  engine.download = async (...args) => {
    if (failSecond && String(args[0]).includes('#item=2')) throw new Error('CDN ngambek')
    return origDownload(...args)
  }
  const registry = { getEngine: () => engine }
  const events1 = []
  const patches1 = []
  const job1 = {
    id: 6, url: 'https://gofile.io/d/abc', provider: 'gofile', chat: 'c', sender: 'A',
    sessionPick: true, userMsgKey: { id: 'allmsg' },
    batch: { name: 'Folderku', items: FILES.map((f, i) => ({ index: i, ...f })), progress: { done: [], failed: [], kept: [] } },
  }
  await runDownloadJob({ conn: fakeConn(events1), job: job1, registry, rootDir: dir, waMaxBytes: 25, updateJob: async (id, patch) => { patches1.push(patch) } })
  const progress1 = patches1.at(-1).batch.progress
  assert.deepEqual(progress1.done, [0], 'item 1 terkirim')
  assert.equal(progress1.failed.length, 1, 'item 2 gagal')
  assert.equal(progress1.kept.length, 1, 'item 3 oversized tersimpan')
  assert.equal(progress1.kept[0].reason, 'oversized')
  const summary1 = events1.find(e => typeof e.text === 'string' && /Batch/.test(e.text)).text
  assert.match(summary1, /1 dari 3 file terkirim/)
  assert.match(summary1, /gagal/)
  const keptDir = await fs.readdir(path.join(dir, 'src', 'downloads', 'gofile'))
  assert.equal(keptDir.length, 1, 'folder batch dipertahankan karena ada file tersimpan')

  // Resume: CDN pulih, job diklaim ulang dengan progres run 1.
  failSecond = false
  const events2 = []
  const job2 = { ...job1, id: 7, batch: { name: 'Folderku', items: FILES.map((f, i) => ({ index: i, ...f })), progress: progress1 } }
  await runDownloadJob({ conn: fakeConn(events2), job: job2, registry, rootDir: dir, waMaxBytes: 25, updateJob: async () => {} })
  const sent2 = events2.filter(e => e.file).map(e => e.file)
  assert.deepEqual(sent2, ['dua.mp4'], 'resume hanya mengirim item yang gagal; done/kept dilewati')
})

// ─── Hook pick ──────────────────────────────────────────────────────────────

function pickSetup(sessionValue, snapshotJobs = []) {
  const store = createPickSessionStore()
  if (sessionValue) store.put('c', 'A', sessionValue)
  const enqueued = []
  const queue = {
    enqueued,
    enqueue: async input => { enqueued.push(input); return { job: { id: 99 }, position: 1, liveCount: 1 } },
    snapshot: async () => ({ jobs: snapshotJobs }),
    updateNotice: async () => {},
  }
  const connEvents = []
  const conn = { sendMessage: async (chat, content) => { connEvents.push(content) } }
  const replies = []
  const m = (text, extra = {}) => ({
    fromMe: false, text, chat: 'c', sender: 'A', key: { remoteJid: 'c', id: 'k1' },
    pushName: 'Tes', conn,
    reply: async t => { replies.push(t) },
    ...extra,
  })
  return { store, queue, enqueued, connEvents, replies, m, ctx: { conn, pickSessions: store, downloadQueue: queue } }
}

const SESSION = {
  provider: 'gofile', baseUrl: 'https://gofile.io/d/abc', title: 'Folderku',
  items: FILES, lastBatch: null,
}

test('pick hook: angka mengantrekan #item, sesi tetap buka', async () => {
  const s = pickSetup(SESSION)
  const consumed = await pickHandler.before(s.m('2'), s.ctx)
  assert.equal(consumed, true)
  assert.equal(s.enqueued.length, 1)
  assert.equal(s.enqueued[0].url, 'https://gofile.io/d/abc#item=2')
  assert.equal(s.enqueued[0].sessionPick, true)
  assert.ok(s.connEvents.some(e => e.react?.text === '⏳'), 'react ⏳ menempel di pesan angka')
  assert.ok(s.store.get('c', 'A'), 'sesi tidak tertutup setelah pick')
})

test('pick hook: angka di luar daftar dibalas koreksi tanpa antrean', async () => {
  const s = pickSetup(SESSION)
  assert.equal(await pickHandler.before(s.m('9'), s.ctx), true)
  assert.equal(s.enqueued.length, 0)
  assert.match(s.replies[0], /di luar daftar/)
})

test('pick hook: all mengantrekan satu job batch berisi semua item', async () => {
  const s = pickSetup(SESSION)
  assert.equal(await pickHandler.before(s.m('all'), s.ctx), true)
  assert.equal(s.enqueued.length, 1)
  assert.equal(s.enqueued[0].url, 'https://gofile.io/d/abc')
  assert.deepEqual(s.enqueued[0].batch.items.map(i => i.index), [0, 1, 2])
  assert.equal(s.enqueued[0].batch.name, 'Folderku')
})

test('pick hook: batal menutup sesi; lanjut melaporkan batch hidup / mengulang gagal', async () => {
  const s = pickSetup(SESSION)
  assert.equal(await pickHandler.before(s.m('batal'), s.ctx), true)
  assert.equal(s.store.get('c', 'A'), null)
  assert.match(s.replies[0], /ditutup/)

  const live = pickSetup(SESSION, [{ id: 42, sender: 'A', url: 'https://gofile.io/d/abc', status: 'active', batch: { items: [{}, {}, {}], progress: { done: [0], failed: [], kept: [] } } }])
  assert.equal(await pickHandler.before(live.m('lanjut'), live.ctx), true)
  assert.match(live.replies[0], /masih berjalan/)
  assert.match(live.replies[0], /1\/3/)
  assert.equal(live.enqueued.length, 0)

  const retry = pickSetup({ ...SESSION, lastBatch: { failed: [1], kept: [] } })
  assert.equal(await pickHandler.before(retry.m('lanjut'), retry.ctx), true)
  assert.equal(retry.enqueued.length, 1)
  assert.deepEqual(retry.enqueued[0].batch.items.map(i => i.index), [1], 'lanjut hanya mengulang item gagal')

  const none = pickSetup(SESSION)
  assert.equal(await pickHandler.before(none.m('lanjut'), none.ctx), true)
  assert.match(none.replies[0], /Tidak ada batch/)
})

test('pick hook: tanpa sesi / teks biasa / pesan bot dilewati', async () => {
  const s = pickSetup(null)
  assert.equal(await pickHandler.before(s.m('2'), s.ctx), false)
  assert.equal(s.enqueued.length, 0)
  const s2 = pickSetup(SESSION)
  assert.equal(await pickHandler.before(s2.m('halo'), s2.ctx), false)
  assert.equal(await pickHandler.before(s2.m('2', { fromMe: true }), s2.ctx), false)
  assert.equal(s2.enqueued.length, 0)
})
