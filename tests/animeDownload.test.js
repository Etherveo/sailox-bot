import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runDownloadJob } from '../lib/downloader/runJob.js'
import { getDownloadQueue } from '../lib/downloader/queue.js'
import { ensureJobProcessor } from '../lib/downloader/processor.js'
import { startBackgroundDriveSync } from '../lib/downloader/driveSync.js'
import { createAnimeNameMap } from '../lib/helpers/animeNameMap.js'
import animedownload from '../plugins/downloader/animedownload.js'
import download from '../plugins/downloader/download.js'

// ─── harness runJob ──────────────────────────────────────────────────────────

function fakeConn() {
  const sent = []
  const files = []
  return {
    sent,
    files,
    sendMessage: async (chat, content) => { sent.push(content.text ?? ''); return {} },
    sendFile: async (chat, filePath, fileName, caption, quoted, flag, opts) => { files.push({ filePath, fileName, opts }) },
    identity: { roleOf: () => ({ isFounder: true }) },
  }
}

function fakeEngine({ fileName = 'Kuramanime-XXX-01-720p.mp4', size = 5, ext = '.mp4', mime = 'video/mp4', sparse = false } = {}) {
  return {
    id: 'fakehost',
    getInfo: async () => ({ fileName, size, fileUrl: 'https://fakehost.test/f' }),
    download: async (url, info, { destDir, baseName }) => {
      const filePath = path.join(destDir, `${baseName}${ext}`)
      if (sparse) {
        const fh = await fsp.open(filePath, 'w')
        await fh.truncate(size)
        await fh.close()
      } else {
        await fsp.writeFile(filePath, 'halo!')
      }
      return { filePath, fileName: `${baseName}${ext}`, mimetype: mime, size }
    },
  }
}

async function tempRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sailox-adl-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  return root
}

const baseJob = (options) => ({
  id: 1, url: 'https://fakehost.test/f', provider: 'fakehost',
  chat: 'tes@s.whatsapp.net', sender: 'founder@s.whatsapp.net', senderName: '',
  ...(options ? { options } : {}),
})

// ─── runJob: opsi job .animedownload ────────────────────────────────────────

test('adl/runJob: forceDocument mengirim foto pun sebagai dokumen', async t => {
  const rootDir = await tempRoot(t)
  const conn = fakeConn()
  const engine = fakeEngine({ fileName: 'gambar.png', ext: '.png', mime: 'image/png' })
  await runDownloadJob({ conn, job: baseJob({ forceDocument: true }), registry: { getEngine: () => engine }, rootDir })
  assert.equal(conn.files.length, 1)
  assert.equal(conn.files[0].opts?.asDocument, true)

  const conn2 = fakeConn()
  await runDownloadJob({ conn: conn2, job: baseJob(null), registry: { getEngine: () => engine }, rootDir })
  assert.equal(conn2.files[0].opts?.asDocument, undefined, 'tanpa flag, foto tetap foto')
})

test('adl/runJob: customName menimpa mapping dan nama asli', async t => {
  const rootDir = await tempRoot(t)
  const conn = fakeConn()
  const engine = fakeEngine()
  await runDownloadJob({ conn, job: baseJob({ animeName: true, customName: 'Nama Kustom' }), registry: { getEngine: () => engine }, rootDir })
  assert.equal(conn.files[0].fileName, 'Nama Kustom.mp4')
  assert.ok(conn.sent.some(s => s.includes('📝 Nama final: Nama Kustom.mp4')))
})

test('adl/runJob: nama dari mapping anime (store aktif) dipakai untuk file', async t => {
  const rootDir = await tempRoot(t)
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sailox-adl-map-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const store = createAnimeNameMap({ filePath: path.join(dir, 'anime-map.json') })
  store.add('REDRIVER', { title: 'Sora wa Akai Kawa no Hotori' })
  globalThis.animeNameMap = store
  t.after(() => { delete globalThis.animeNameMap })

  const conn = fakeConn()
  const engine = fakeEngine({ fileName: 'Kuramanime-REDRIVER-01-720p.mp4' })
  await runDownloadJob({ conn, job: baseJob({ animeName: true, customName: null }), registry: { getEngine: () => engine }, rootDir })
  assert.equal(conn.files[0].fileName, '[NEW] Sora wa Akai Kawa no Hotori - Episode 01 Subtitle Indonesia 720p.mp4')
})

test('adl/runJob: uploadToDrive menahan penghapusan folder job sesudah terkirim', async t => {
  const rootDir = await tempRoot(t)
  const engine = fakeEngine()
  const conn1 = fakeConn()
  const kept = await runDownloadJob({ conn: conn1, job: baseJob({ uploadToDrive: true }), registry: { getEngine: () => engine }, rootDir })
  assert.equal(fs.existsSync(kept.filePath), true, 'file dipertahankan untuk upload Drive (Fase 4)')

  const conn2 = fakeConn()
  const gone = await runDownloadJob({ conn: conn2, job: baseJob(null), registry: { getEngine: () => engine }, rootDir })
  assert.equal(fs.existsSync(gone.filePath), false, 'tanpa flag, folder job dibersihkan seperti .dl biasa')
})

test('adl/runJob: permukaan penjaga dari options; bawaan tetap permukaan .dl', async t => {
  const rootDir = await tempRoot(t)
  const bigSize = 151 * 1024 * 1024
  const engine = fakeEngine({ size: bigSize, sparse: true })
  const surfaces = []
  const bigSend = {
    request: async ({ surface }) => { surfaces.push(surface); return { granted: true, token: 'tok-1' } },
    release: () => {},
    check: () => ({ allowed: true }),
  }
  const conn1 = fakeConn()
  await runDownloadJob({ conn: conn1, job: baseJob({ bigSendSurface: 'downloader/animedownload.js' }), registry: { getEngine: () => engine }, rootDir, bigSend })
  const conn2 = fakeConn()
  await runDownloadJob({ conn: conn2, job: baseJob(null), registry: { getEngine: () => engine }, rootDir, bigSend })
  assert.deepEqual(surfaces, ['downloader/animedownload.js', 'downloader/download.js'])
})

// ─── Fase 4: sentToWa + upload Drive latar ──────────────────────────────────

test('adl/runJob: hasil membawa sentToWa untuk pengait upload Drive', async t => {
  const rootDir = await tempRoot(t)
  const engine = fakeEngine()
  const ok = await runDownloadJob({ conn: fakeConn(), job: baseJob({ uploadToDrive: true }), registry: { getEngine: () => engine }, rootDir })
  assert.equal(ok.sentToWa, true)
  const badConn = fakeConn()
  badConn.sendFile = async () => { throw new Error('kirim rusak total') }
  const bad = await runDownloadJob({ conn: badConn, job: baseJob({ uploadToDrive: true }), registry: { getEngine: () => engine }, rootDir })
  assert.equal(bad.sentToWa, false)
})

async function syncFixture(t, syncFile) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sailox-dsync-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const jobDir = path.join(dir, 'job-dl1')
  await fsp.mkdir(jobDir, { recursive: true })
  const filePath = path.join(jobDir, 'Ep 01.mp4')
  await fsp.writeFile(filePath, 'halo!')
  const conn = fakeConn()
  const result = { kind: 'file', fileName: 'Ep 01.mp4', size: 5, filePath, relPath: 'src/downloads/fakehost/job-dl1', sentToWa: true }
  await startBackgroundDriveSync({
    conn, job: { id: 3, chat: 'tes@s.whatsapp.net' }, result, rootDir: dir,
    deps: { getClient: async () => ({}), syncFile, folderId: () => 'fold' },
  })
  return { conn, filePath, jobDir }
}

test('adl/driveSync: terunggah -> folder job dihapus + laporan selesai', async t => {
  const { conn, jobDir } = await syncFixture(t, async () => ({ status: 'uploaded', fileName: 'Ep 01.mp4', id: 'x', webViewLink: 'https://drive.example/f', size: 5 }))
  assert.equal(fs.existsSync(jobDir), false)
  assert.ok(conn.sent.some(s => s.includes('Upload Drive selesai') && s.includes('https://drive.example/f')))
})

test('adl/driveSync: duplikat di Drive dihitung sukses -> folder tetap dibersihkan', async t => {
  const { conn, jobDir } = await syncFixture(t, async () => ({ status: 'skipped', reason: 'File dengan nama sama sudah ada di folder tujuan.', fileName: 'Ep 01.mp4', id: 'lama', size: 5 }))
  assert.equal(fs.existsSync(jobDir), false)
  assert.ok(conn.sent.some(s => s.includes('sudah ada di Drive')))
})

test('adl/driveSync: skipped tanpa id (di atas batas) -> file dipertahankan + alasan dilaporkan', async t => {
  const { conn, filePath } = await syncFixture(t, async () => ({ status: 'skipped', reason: 'File melebihi batas maksimum 10 GiB.', fileName: 'Ep 01.mp4', size: 5 }))
  assert.equal(fs.existsSync(filePath), true)
  assert.ok(conn.sent.some(s => s.includes('tidak diunggah ke Drive') && s.includes('10 GiB')))
})

test('adl/driveSync: upload gagal -> file dipertahankan + error mentah dilaporkan', async t => {
  const { conn, filePath } = await syncFixture(t, async () => { throw new Error('kuota Drive habis') })
  assert.equal(fs.existsSync(filePath), true)
  assert.ok(conn.sent.some(s => s.includes('Upload Drive gagal') && s.includes('kuota Drive habis')))
})

test('adl/processor: job uploadToDrive terunggah di latar sesudah terkirim, folder dibersihkan', async t => {
  const rootDir = await tempRoot(t)
  const uploaded = []
  globalThis.uptodriveClient = {
    findChildByName: async () => null,
    uploadFile: async (p, { name }) => { uploaded.push(name); return { id: 'drv1', webViewLink: 'https://drive.example/f' } },
    getOrCreateFolder: async () => ({ id: 'fold', created: false }),
  }
  t.after(() => { delete globalThis.uptodriveClient })
  const conn = fakeConn()
  const queue = getDownloadQueue(rootDir)
  ensureJobProcessor({ conn, queue, registry: { getEngine: () => fakeEngine() }, rootDir })
  await queue.enqueue({
    url: 'https://fakehost.test/f', provider: 'fakehost', chat: 'tes@s.whatsapp.net',
    sender: 'founder@s.whatsapp.net', senderName: '', options: { uploadToDrive: true },
  })
  const deadline = Date.now() + 8000
  for (;;) {
    const snap = await queue.snapshot()
    if (!snap.jobs.length && uploaded.length && conn.sent.some(s => s.includes('Upload Drive selesai'))) break
    if (Date.now() > deadline) throw new Error('timeout menunggu prosesor + driveSync')
    await new Promise(r => setTimeout(r, 50))
  }
  assert.deepEqual(uploaded, ['Kuramanime-XXX-01-720p.mp4'])
  const left = await fsp.readdir(path.join(rootDir, 'src', 'downloads', 'fakehost')).catch(() => [])
  assert.deepEqual(left, [], 'folder job dibersihkan driveSync')
})

// ─── plugin .animedownload ───────────────────────────────────────────────────

function fakeM() {
  const replies = []
  return { chat: 'tes@s.whatsapp.net', sender: 'founder@s.whatsapp.net', pushName: 'Veo', replies, reply: async teks => { replies.push(String(teks)) } }
}

function fakeQueue() {
  const enqueued = []
  return {
    enqueued,
    enqueue: async input => { enqueued.push(input); return { job: { id: 7, ...input }, position: 1, liveCount: 1 } },
    snapshot: async () => ({ jobs: [] }),
  }
}

const fakeRegistry = {
  detectProvider: url => url.includes('pixeldrain') ? 'pixeldrain' : url.includes('tiktok') ? 'tiktok' : null,
  getEngine: () => null,
}

function pluginConn() {
  return { sendMessage: async () => ({}), sendFile: async () => {}, identity: { roleOf: () => ({}) } }
}

async function thrown(fn) {
  try { await fn(); return null } catch (e) { return String(e?.message ?? e) }
}

test('adl/plugin: enqueue membawa options anime lengkap; isUpload bawaan 1', async t => {
  const q = fakeQueue()
  const m = fakeM()
  await animedownload(m, { conn: pluginConn(), text: 'https://pixeldrain.com/d/xxxx', usedPrefix: '.', command: 'adl', downloadQueue: q, downloaderRegistry: fakeRegistry })
  assert.equal(q.enqueued.length, 1)
  assert.deepEqual(q.enqueued[0].options, {
    animeName: true, customName: null, forceDocument: true,
    uploadToDrive: true, bigSendSurface: 'downloader/animedownload.js',
  })
  assert.match(m.replies.at(-1), /Masuk antrean #7/)
  assert.match(m.replies.at(-1), /Upload Drive: Ya/)
})

test('adl/plugin: customName + isUpload 0 terbaca dari format pipa', async t => {
  const q = fakeQueue()
  const m = fakeM()
  await animedownload(m, { conn: pluginConn(), text: 'https://pixeldrain.com/d/xxxx | Nama Saya | 0', usedPrefix: '.', command: 'animedownload', downloadQueue: q, downloaderRegistry: fakeRegistry })
  assert.equal(q.enqueued[0].options.customName, 'Nama Saya')
  assert.equal(q.enqueued[0].options.uploadToDrive, false)
  assert.match(m.replies.at(-1), /Upload Drive: Tidak/)
})

test('adl/plugin: provider di luar daftar anime dan domain asing ditolak', async t => {
  const q = fakeQueue()
  const e1 = await thrown(() => animedownload(fakeM(), { conn: pluginConn(), text: 'https://www.tiktok.com/@x/video/1', usedPrefix: '.', command: 'adl', downloadQueue: q, downloaderRegistry: fakeRegistry }))
  assert.match(e1, /tidak termasuk AnimeDownload/)
  const e2 = await thrown(() => animedownload(fakeM(), { conn: pluginConn(), text: 'https://asing.example/f', usedPrefix: '.', command: 'adl', downloadQueue: q, downloaderRegistry: fakeRegistry }))
  assert.match(e2, /belum didukung sama sekali/)
  const e3 = await thrown(() => animedownload(fakeM(), { conn: pluginConn(), text: 'https://pixeldrain.com/d/xxxx | | 2', usedPrefix: '.', command: 'adl', downloadQueue: q, downloaderRegistry: fakeRegistry }))
  assert.match(e3, /isUpload tidak dikenal/)
  assert.equal(q.enqueued.length, 0)
})

test('adl/plugin: metadata founder + bigSend + alias perintah', () => {
  assert.equal(animedownload.founder, true)
  assert.equal(animedownload.bigSend, true)
  assert.deepEqual(animedownload.tags, ['downloader'])
  for (const c of ['animedownload', 'adl', 'animedl', 'nimedl']) assert.match(c, animedownload.command)
})

// ─── regresi: .dl sesudah kabel prosesor dipindah ke processor.js ──────────

test('dl: handler masih mengantrekan job polos tanpa options anime', async t => {
  const q = fakeQueue()
  const m = fakeM()
  await download(m, { conn: pluginConn(), text: 'https://pixeldrain.com/d/xxxx', usedPrefix: '.', command: 'dl', downloadQueue: q, downloaderRegistry: fakeRegistry })
  assert.equal(q.enqueued.length, 1)
  assert.equal(q.enqueued[0].options, undefined)
  assert.match(m.replies.at(-1), /Masuk antrean #7/)
})
