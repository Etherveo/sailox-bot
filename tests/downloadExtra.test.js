import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createDownloadQueue } from '../lib/downloader/queue.js'
import { runDownloadJob } from '../lib/downloader/runJob.js'
import { createEngineRegistry } from '../lib/downloader/registry.js'
import downloadHandler, { extractDownloadUrl } from '../plugins/downloader/download.js'
import * as gofile from '../lib/downloader/engines/gofile.js'
import * as sfile from '../lib/downloader/engines/sfile.js'
import * as videy from '../lib/downloader/engines/videy.js'
import * as krakenfiles from '../lib/downloader/engines/krakenfiles.js'

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-dl-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}
async function waitFor(fn, timeout = 4000) {
  const start = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise(r => setTimeout(r, 15))
  }
}

// ─── Smart parsing link ──────────────────────────────────────────────────────

test('extractDownloadUrl: menemukan link valid di tengah teks, token terpisah spasi', () => {
  assert.equal(extractDownloadUrl('ambilin dong https://pixeldrain.com/u/abc123 makasih'), 'https://pixeldrain.com/u/abc123')
  assert.equal(extractDownloadUrl('cek (https://gofile.io/d/xyz789), bagus'), 'https://gofile.io/d/xyz789')
  assert.equal(extractDownloadUrl('bukan link: https://'), null)
  assert.equal(extractDownloadUrl('menempelhttps://pixeldrain.com/u/abc tanpa spasi'), null, 'link yang menempel pada kata BUKAN token sendiri — aturan pemilik: link harus diapit spasi')
  assert.equal(extractDownloadUrl('', 'teks balasan berisi https://sfile.mobi/abc di tengah'), 'https://sfile.mobi/abc')
  assert.equal(extractDownloadUrl('tanpa link sama sekali'), null)
})

// ─── Antrean JSON ────────────────────────────────────────────────────────────

test('antrean: state hidup di file JSON, job selesai berurutan per pengguna', async t => {
  const dir = await tmpDir(t)
  const file = path.join(dir, 'q.json')
  const order = []
  const queue = createDownloadQueue({
    file,
    processJob: async job => { order.push(`start:${job.id}`); await new Promise(r => setTimeout(r, 10)); order.push(`end:${job.id}`); return { fileName: 'f.bin', size: 1 } },
  })
  await queue.enqueue({ url: 'https://x/1', provider: 'pixeldrain', chat: 'c', sender: 'A' })
  await queue.enqueue({ url: 'https://x/2', provider: 'pixeldrain', chat: 'c', sender: 'A' })
  await queue.enqueue({ url: 'https://x/3', provider: 'pixeldrain', chat: 'c', sender: 'B' })
  await waitFor(async () => (await queue.snapshot()).pending === 0 && (await queue.snapshot()).active === 0)
  const saved = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(saved.jobs.length, 0, 'job selesai langsung dibersihkan dari file antrean')
  assert.equal(saved.seq, 3, 'nomor urut tetap naik walau entri dibersihkan')
  assert.ok(order.indexOf('start:2') > order.indexOf('end:1'), 'job pengguna yang sama tidak berjalan tumpang tindih / mendahului')
  assert.ok(order.indexOf('start:3') < order.indexOf('end:2'), 'pengguna lain boleh menyalip job yang masih menunggu giliran per-penggunanya')
})

test('antrean: batas per pengguna & total ditegakkan', async t => {
  const dir = await tmpDir(t)
  const queue = createDownloadQueue({ file: path.join(dir, 'q.json'), processJob: async () => ({}), maxConcurrent: 0, maxPendingPerUser: 2, maxPendingTotal: 3 })
  await queue.enqueue({ url: 'u1', provider: 'p', chat: 'c', sender: 'A' })
  await queue.enqueue({ url: 'u2', provider: 'p', chat: 'c', sender: 'A' })
  await assert.rejects(queue.enqueue({ url: 'u3', provider: 'p', chat: 'c', sender: 'A' }), /sudah punya 2/)
  await queue.enqueue({ url: 'u4', provider: 'p', chat: 'c', sender: 'B' })
  await assert.rejects(queue.enqueue({ url: 'u5', provider: 'p', chat: 'c', sender: 'B' }), /penuh/)
})

test('antrean: job active yatim dipulihkan saat antrean berjalan lagi (resume)', async t => {
  const dir = await tmpDir(t)
  const file = path.join(dir, 'q.json')
  await fs.writeFile(file, JSON.stringify({ seq: 1, jobs: [{ id: 1, url: 'https://x/1', provider: 'pixeldrain', chat: 'c', sender: 'A', senderName: '', status: 'active', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null, fileName: null, size: null, error: null }] }))
  let processed = 0
  const queue = createDownloadQueue({ file, processJob: async () => { processed++; return {} } })
  queue.kick()
  await waitFor(async () => (await queue.snapshot()).jobs.length === 0 && processed === 1)
  assert.equal(processed, 1)
})

test('antrean: NO_CONN mengembalikan job ke pending tanpa gagal, kick memproses ulang', async t => {
  const dir = await tmpDir(t)
  let attempts = 0
  const queue = createDownloadQueue({
    file: path.join(dir, 'q.json'),
    processJob: async () => { attempts++; if (attempts === 1) { const e = new Error('belum ada conn'); e.code = 'NO_CONN'; throw e } return {} },
  })
  await queue.enqueue({ url: 'u', provider: 'p', chat: 'c', sender: 'A' })
  await waitFor(async () => (await queue.snapshot()).jobs[0]?.status === 'pending' && attempts === 1)
  queue.kick()
  await waitFor(async () => (await queue.snapshot()).jobs.length === 0 && attempts === 2)
  assert.equal(attempts, 2)
})

test('antrean: batal hanya job pending milik sendiri', async t => {
  const dir = await tmpDir(t)
  const queue = createDownloadQueue({ file: path.join(dir, 'q.json'), processJob: async () => ({}), maxConcurrent: 0 })
  const { job } = await queue.enqueue({ url: 'u', provider: 'p', chat: 'c', sender: 'A' })
  await assert.rejects(queue.cancel(job.id, 'B'), /bukan antrean milikmu/)
  const cancelled = await queue.cancel(job.id, 'A')
  assert.equal(cancelled.status, 'cancelled')
})

// ─── runJob: info dulu, baru unduh, lalu kirim ───────────────────────────────

function fakeEngine(events, { size = 5, isList = false } = {}) {
  return {
    async getInfo() {
      events.push('getInfo')
      if (isList) return { isList: true, fileName: 'Listku', size: 300, files: [{ fileName: 'a.mp4', size: 100 }, { fileName: 'b.mp4', size: 200 }] }
      return { fileName: 'lagu.mp3', size, mimetype: 'audio/mpeg', createTime: 1700000000 }
    },
    async download(url, info, { destDir, baseName }) {
      events.push('download')
      const filePath = path.join(destDir, baseName + '.mp3')
      await fs.writeFile(filePath, 'x'.repeat(size))
      return { filePath, fileName: 'lagu.mp3', mimetype: 'audio/mpeg', size }
    },
  }
}
function fakeConn(events) {
  return {
    sendMessage: async (chat, content) => { events.push({ type: 'msg', text: content.text }) },
    sendFile: async () => { events.push({ type: 'file' }) },
  }
}

test('runJob: info terkirim SEBELUM download dimulai, file terkirim, folder job dibersihkan', async t => {
  const dir = await tmpDir(t)
  const events = []
  const registry = { getEngine: () => fakeEngine(events) }
  const result = await runDownloadJob({ conn: fakeConn(events), job: { id: 7, url: 'https://pixeldrain.com/u/x', provider: 'pixeldrain', chat: 'c', sender: 'A', senderName: 'Tes' }, registry, rootDir: dir })
  assert.equal(result.kind, 'file')
  const infoIdx = events.findIndex(e => e.type === 'msg' && /Informasi File/.test(e.text))
  const dlIdx = events.indexOf('download')
  const fileIdx = events.findIndex(e => e.type === 'file')
  assert.ok(infoIdx > -1 && dlIdx > -1 && infoIdx < dlIdx, 'info harus mendahului unduhan')
  assert.ok(fileIdx > dlIdx, 'pengiriman setelah unduhan')
  assert.match(events[infoIdx].text, /audio\/mpeg/)
  const leftovers = await fs.readdir(path.join(dir, 'src', 'downloads', 'pixeldrain'))
  assert.deepEqual(leftovers, [], 'folder job dibersihkan setelah file terkirim')
})

test('runJob: list langsung ditampilkan tanpa unduhan', async t => {
  const dir = await tmpDir(t)
  const events = []
  const registry = { getEngine: () => fakeEngine(events, { isList: true }) }
  const result = await runDownloadJob({ conn: fakeConn(events), job: { id: 1, url: 'u', provider: 'pixeldrain', chat: 'c', sender: 'A' }, registry, rootDir: dir })
  assert.equal(result.kind, 'list')
  assert.ok(!events.includes('download'))
  assert.match(events.find(e => e.type === 'msg').text, /Isi Pixeldrain/)
})

test('runJob: file terlalu besar untuk WA disimpan & dilaporkan, tidak dipaksakan', async t => {
  const dir = await tmpDir(t)
  const events = []
  const registry = { getEngine: () => fakeEngine(events, { size: 30 }) }
  const result = await runDownloadJob({ conn: fakeConn(events), job: { id: 2, url: 'u', provider: 'pixeldrain', chat: 'c', sender: 'A' }, registry, rootDir: dir, waMaxBytes: 10 })
  assert.equal(result.kind, 'file')
  assert.ok(!events.some(e => e.type === 'file'), 'tidak dikirim ke WA')
  assert.match(events.at(-1).text, /Unduhan #2 selesai/)
})

// ─── Plugin .download/.dl ────────────────────────────────────────────────────

function dlFixture(t, rootDir) {
  const events = []
  const engine = fakeEngine(events)
  const registry = {
    detectProvider: url => String(url).includes('pixeldrain') ? 'pixeldrain' : null,
    getEngine: () => engine,
  }
  const conn = fakeConn(events)
  const queue = createDownloadQueue({
    file: path.join(rootDir, 'q.json'),
    processJob: job => runDownloadJob({ conn, job, registry, rootDir }),
  })
  const replies = []
  const m = { chat: 'chat@g.us', sender: '111@s.whatsapp.net', pushName: 'Tes', quoted: null, reply: async teks => { replies.push(String(teks)) } }
  const ctx = text => ({ conn, text, usedPrefix: '.', command: 'dl', downloaderRegistry: registry, downloadQueue: queue })
  return { events, registry, conn, queue, replies, m, ctx }
}

test('.dl teks langsung: link ditemukan di tengah kalimat, job diproses sampai file terkirim', async t => {
  const dir = await tmpDir(t)
  const f = dlFixture(t, dir)
  await downloadHandler(f.m, f.ctx('ambilin dong https://pixeldrain.com/u/abc123 makasih'))
  assert.match(f.replies.at(-1), /Masuk antrean #1/)
  await waitFor(async () => (await f.queue.snapshot()).jobs.length === 0)
  assert.ok(f.events.some(e => e.type === 'msg' && /Informasi File/.test(e.text)))
  assert.ok(f.events.some(e => e.type === 'file'))
})

test('.dl balas pesan: link diambil dari teks pesan yang dibalas', async t => {
  const dir = await tmpDir(t)
  const f = dlFixture(t, dir)
  f.m.quoted = { text: 'nih file-nya https://pixeldrain.com/u/xyz789 ya' }
  await downloadHandler(f.m, f.ctx(''))
  assert.match(f.replies.at(-1), /Masuk antrean #1/)
  assert.match(f.replies.at(-1), /xyz789/, 'link dari pesan yang dibalas masuk ke antrean')
  await waitFor(async () => (await f.queue.snapshot()).jobs.length === 0)
  assert.ok(f.events.some(e => e.type === 'file'), 'job dari link balasan tetap diproses sampai terkirim')
})

test('.dl tanpa link & domain tak didukung: ditolak dengan petunjuk', async t => {
  const dir = await tmpDir(t)
  const f = dlFixture(t, dir)
  await assert.rejects(downloadHandler(f.m, f.ctx('halo apa kabar')), /Download file dari link/)
  await assert.rejects(downloadHandler(f.m, f.ctx('https://example.com/file.zip')), /belum didukung/)
})

test('.dl antrean & batal: sub-perintah mengelola antrean sendiri', async t => {
  const dir = await tmpDir(t)
  const f = dlFixture(t, dir)
  const blocked = createDownloadQueue({ file: path.join(dir, 'q2.json'), processJob: async () => ({}), maxConcurrent: 0 })
  const ctx2 = text => ({ ...f.ctx(text), downloadQueue: blocked })
  await downloadHandler(f.m, ctx2('https://pixeldrain.com/u/abc'))
  await downloadHandler(f.m, ctx2('antrean'))
  assert.match(f.replies.at(-1), /Menunggu: 1/)
  assert.match(f.replies.at(-1), /#1 — Pixeldrain/)
  await downloadHandler(f.m, ctx2('batal 1'))
  assert.match(f.replies.at(-1), /dibatalkan/)
  assert.equal((await blocked.snapshot()).jobs.length, 0, 'job batal langsung keluar dari antrean')
})

// ─── Engine baru ─────────────────────────────────────────────────────────────

test('engine baru terdaftar di registry nyata & deteksi provider bekerja', async () => {
  const registry = createEngineRegistry({ dir: path.join(process.cwd(), 'lib/downloader/engines') })
  await registry.loadAll()
  for (const id of ['gofile', 'sfile', 'videy', 'krakenfiles', 'pixeldrain', 'mediafire']) {
    assert.ok(registry.has(id), `engine ${id} harus aktif`)
  }
  assert.equal(registry.detectProvider('https://gofile.io/d/abc123'), 'gofile')
  assert.equal(registry.detectProvider('https://sfile.mobi/abc123'), 'sfile')
  assert.equal(registry.detectProvider('https://videy.co/v/?id=xsRK8QZ21'), 'videy')
  assert.equal(registry.detectProvider('https://krakenfiles.com/view/xx/file.html'), 'krakenfiles')
  assert.equal(registry.detectProvider('https://gofile.io.evil.test/d/abc'), null)
})

test('gofile: folder jadi list, #item memilih file, token tamu + WT dipakai', async () => {
  const payload = {
    status: 'ok',
    data: {
      name: 'Folderku',
      childrenIds: ['a', 'b'],
      children: {
        a: { type: 'file', name: 'satu.mp4', size: 100, mimetype: 'video/mp4', link: 'https://file/satu', createTime: 1700000000 },
        b: { type: 'file', name: 'dua.mp4', size: 200, mimetype: 'video/mp4', link: 'https://file/dua' },
      },
    },
  }
  let sawAuth = false
  const fetchFn = async (url, opts = {}) => {
    const u = String(url)
    if (u.includes('/accounts')) return Response.json({ data: { token: 'TOK' } })
    if (u.includes('/contents/')) {
      assert.equal(opts.headers?.Authorization, 'Bearer TOK')
      assert.match(opts.headers?.['X-Website-Token'] ?? '', /^[0-9a-f]{64}$/)
      assert.equal(opts.headers?.['X-BL'], 'en-US')
      sawAuth = true
      return Response.json(payload)
    }
    throw new Error('route asing: ' + u)
  }
  const list = await gofile.getInfo('https://gofile.io/d/abc123', { fetchFn })
  assert.equal(list.isList, true)
  assert.equal(list.files.length, 2)
  assert.equal(list.size, 300)
  const picked = await gofile.getInfo('https://gofile.io/d/abc123#item=2', { fetchFn })
  assert.equal(picked.fileName, 'dua.mp4')
  assert.equal(picked.downloadUrl, 'https://file/dua')
  assert.equal(picked.token, 'TOK')
  assert.ok(sawAuth)
  assert.equal(gofile.match('https://gofile.io/d/abc123'), true)
  assert.equal(gofile.match('https://gofile.io.evil.test/d/abc'), false)
})

test('gofile: WT deterministik dalam satu jendela waktu, berubah di jendela berikut', () => {
  const a = gofile.generateWT('TOK', 1_700_000_000_000)
  const b = gofile.generateWT('TOK', 1_700_000_000_000 + 1000)
  const c = gofile.generateWT('TOK', 1_700_000_000_000 + 14400 * 1000)
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('gofile download: header Bearer + WT diteruskan & file ter-stream ke disk', async t => {
  const dir = await tmpDir(t)
  let headers = null
  const fetchFn = async (url, opts = {}) => { headers = opts.headers ?? null; return new Response('isi-file', { status: 200, headers: { 'content-type': 'video/mp4' } }) }
  const result = await gofile.download('https://gofile.io/d/abc', { downloadUrl: 'https://file/dua', token: 'TOK', fileName: 'dua.mp4' }, { destDir: dir, baseName: 'dua', fetchFn })
  assert.equal(headers?.Authorization, 'Bearer TOK')
  assert.match(headers?.['X-Website-Token'] ?? '', /^[0-9a-f]{64}$/)
  assert.equal(headers?.Referer, 'https://gofile.io/')
  assert.equal(await fs.readFile(result.filePath, 'utf8'), 'isi-file')
})

test('sfile: scrape halaman mengambil nama, ukuran, dan link unduhan', async () => {
  const html = `<div class="w3-row-padding"><img src="i.png" alt="dokumen.pdf"></div>
<div class="list">dokumen.pdf - application/pdf</div>
<a id="download" href="https://sfile.mobi/download/xyz?key=1">Download File (2.5 MB)</a>`
  const scraped = sfile.scrapeSfile(html)
  assert.equal(scraped.success, true)
  assert.equal(scraped.fileName, 'dokumen.pdf')
  assert.equal(scraped.size, Math.round(2.5 * 1024 * 1024))
  assert.match(scraped.downloadUrl, /&k=1[0-5]$/)
  assert.equal(sfile.parseSizeText('850 KB'), 850 * 1024)
  assert.equal(sfile.match('https://sfile.mobi/abc123'), true)
  assert.equal(sfile.match('https://sfile.mobi.evil.test/abc'), false)
})

test('videy: id diekstrak, info dari HEAD CDN', async () => {
  assert.equal(videy.videoIdOf('https://videy.co/v/?id=xsRK8QZ21'), 'xsRK8QZ21')
  assert.equal(videy.match('https://videy.co/v/?id=xsRK8QZ21'), true)
  assert.equal(videy.match('https://videy.co/'), false)
  const fetchFn = async () => new Response(null, { status: 200, headers: { 'content-length': '12345', 'content-type': 'video/mp4' } })
  const info = await videy.getInfo('https://videy.co/v/?id=xsRK8QZ21', { fetchFn })
  assert.equal(info.downloadUrl, 'https://cdn.videy.co/xsRK8QZ21.mp4')
  assert.equal(info.size, 12345)
})

test('krakenfiles: scrape mengambil <source> video & judul bersih', async () => {
  const html = `<html><head><title>Video Keren - Krakenfiles.com</title></head>
<body><video controls><source src="https://krakenfiles.com/path/vid.mp4" type="video/mp4"></video></body></html>`
  const scraped = krakenfiles.scrapeKraken(html)
  assert.equal(scraped.success, true)
  assert.equal(scraped.title, 'Video Keren')
  assert.equal(scraped.downloadUrl, 'https://krakenfiles.com/path/vid.mp4')
  const fetchFn = async url => String(url).includes('/view/')
    ? new Response(html, { status: 200 })
    : new Response(null, { status: 200, headers: { 'content-length': '999', 'content-type': 'video/mp4' } })
  const info = await krakenfiles.getInfo('https://krakenfiles.com/view/xx/file.html', { fetchFn })
  assert.equal(info.fileName, 'Video Keren.mp4')
  assert.equal(info.size, 999)
  assert.equal(krakenfiles.match('https://krakenfiles.com/view/xx/file.html'), true)
})

// ─── runJob: sniff byte, konversi webp, batch media (album) ─────────────────

const MP4_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from([0, 0, 0, 0]), Buffer.from('isomiso2'), Buffer.alloc(64, 7)])
const JPG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0'), Buffer.alloc(64, 3)])
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([80, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(64, 5)])

function capturingConn(events, { albumKey = { id: 'ALBUM1', remoteJid: 'c' }, failAlbum = false } = {}) {
  return {
    sendMessage: async (chat, content) => {
      if (content.album) {
        events.push({ type: 'album', album: content.album })
        if (failAlbum) throw new Error('album tidak didukung')
        return { key: albumKey }
      }
      events.push({ type: 'msg', text: content.text })
      return { key: { id: 'M' + events.length } }
    },
    sendFile: async (chat, source, filename, caption, quoted, ptt, options) => { events.push({ type: 'file', filename, options }) },
  }
}

test('runJob: nama .bin dari CDN dibetulkan dari magic bytes sebelum dikirim', async t => {
  const dir = await tmpDir(t)
  const events = []
  const engine = {
    async getInfo() { return { fileName: 'instagram-1', size: null, mimetype: null, downloadUrl: 'https://cdn/x' } },
    async download(url, info, { destDir, baseName }) {
      const filePath = path.join(destDir, baseName + '.bin')
      await fs.writeFile(filePath, MP4_BYTES)
      return { filePath, fileName: 'instagram-1.bin', mimetype: 'application/octet-stream', size: MP4_BYTES.length }
    },
  }
  const result = await runDownloadJob({ conn: capturingConn(events), job: { id: 3, url: 'u', provider: 'instagram', chat: 'c', sender: 'A' }, registry: { getEngine: () => engine }, rootDir: dir })
  assert.equal(result.fileName, 'instagram-1.mp4')
  assert.equal(events.find(e => e.type === 'file').filename, 'instagram-1.mp4')
})

test('runJob: batch media — semua item diunduh lalu dikirim sebagai album', async t => {
  const dir = await tmpDir(t)
  const events = []
  const mediaItems = [
    { fileName: 'instagram-1', downloadUrl: 'https://cdn/1' },
    { fileName: 'instagram-2', downloadUrl: 'https://cdn/2' },
    { fileName: 'instagram-3', downloadUrl: 'https://cdn/3' },
  ]
  const payloads = { 'instagram-1': JPG_BYTES, 'instagram-2': MP4_BYTES, 'instagram-3': JPG_BYTES }
  const engine = {
    async getInfo() { return { isList: true, fileName: 'Postingan Instagram', size: null, files: mediaItems.map(i => ({ fileName: i.fileName, size: null })), mediaItems } },
    async download(url, info, { destDir, baseName }) {
      const filePath = path.join(destDir, baseName + '.bin')
      await fs.writeFile(filePath, payloads[baseName])
      return { filePath, fileName: baseName + '.bin', mimetype: 'application/octet-stream', size: payloads[baseName].length }
    },
  }
  const result = await runDownloadJob({ conn: capturingConn(events), job: { id: 4, url: 'u', provider: 'pixeldrain', chat: 'c', sender: 'A', senderName: 'Tes' }, registry: { getEngine: () => engine }, rootDir: dir })
  assert.equal(result.kind, 'media-batch')
  const album = events.find(e => e.type === 'album')
  assert.ok(album, 'pesan album dikirim')
  assert.equal(album.album.expectedImageCount, 2)
  assert.equal(album.album.expectedVideoCount, 1)
  const files = events.filter(e => e.type === 'file')
  assert.equal(files.length, 3)
  assert.ok(files.every(f => f.options?.albumParentKey?.id === 'ALBUM1'), 'semua media terikat ke album yang sama')
  assert.deepEqual(files.map(f => f.filename).sort(), ['instagram-1.jpg', 'instagram-2.mp4', 'instagram-3.jpg'], 'ekstensi dibetulkan dari byte asli')
  assert.match(events.filter(e => e.type === 'msg').at(-1).text, /3 dari 3 file terkirim/)
  assert.deepEqual(await fs.readdir(path.join(dir, 'src', 'downloads', 'pixeldrain')), [], 'folder job dibersihkan')
})

test('runJob: batch media — album gagal, jatuh ke kirim satu per satu', async t => {
  const dir = await tmpDir(t)
  const events = []
  const mediaItems = [
    { fileName: 'instagram-1', downloadUrl: 'https://cdn/1' },
    { fileName: 'instagram-2', downloadUrl: 'https://cdn/2' },
  ]
  const engine = {
    async getInfo() { return { isList: true, fileName: 'Postingan Instagram', size: null, files: mediaItems.map(i => ({ fileName: i.fileName, size: null })), mediaItems } },
    async download(url, info, { destDir, baseName }) {
      const filePath = path.join(destDir, baseName + '.bin')
      await fs.writeFile(filePath, JPG_BYTES)
      return { filePath, fileName: baseName + '.bin', mimetype: 'application/octet-stream', size: JPG_BYTES.length }
    },
  }
  const result = await runDownloadJob({ conn: capturingConn(events, { failAlbum: true }), job: { id: 5, url: 'u', provider: 'pixeldrain', chat: 'c', sender: 'A' }, registry: { getEngine: () => engine }, rootDir: dir })
  assert.equal(result.kind, 'media-batch')
  const files = events.filter(e => e.type === 'file')
  assert.equal(files.length, 2)
  assert.ok(files.every(f => !f.options?.albumParentKey), 'tanpa albumParentKey saat album gagal')
  assert.match(events.filter(e => e.type === 'msg').at(-1).text, /2 dari 2 file terkirim/)
})

test('runJob: foto webp dikonversi ke JPEG sebelum dikirim (anti jadi stiker)', async t => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const dir = await tmpDir(t)
  const seed = path.join(dir, 'seed.webp')
  await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', seed])
  const events = []
  const engine = {
    async getInfo() { return { fileName: 'instagram-1', size: null, mimetype: null, downloadUrl: 'https://cdn/x' } },
    async download(url, info, { destDir, baseName }) {
      const filePath = path.join(destDir, baseName + '.webp')
      await fs.copyFile(seed, filePath)
      const st = await fs.stat(filePath)
      return { filePath, fileName: 'instagram-1.webp', mimetype: 'image/webp', size: st.size }
    },
  }
  const result = await runDownloadJob({ conn: capturingConn(events), job: { id: 6, url: 'u', provider: 'instagram', chat: 'c', sender: 'A' }, registry: { getEngine: () => engine }, rootDir: dir })
  assert.equal(result.fileName, 'instagram-1.jpg')
  assert.equal(events.find(e => e.type === 'file').filename, 'instagram-1.jpg')
})

// ─── Antrean: dedupe link + cooldown 1 menit ─────────────────────────────────

test('antrean: link yang sama ditolak selagi mengantri, lalu cooldown 1 menit setelah keluar', async t => {
  const dir = await tmpDir(t)
  const queue = createDownloadQueue({ file: path.join(dir, 'q.json'), processJob: async () => ({}), maxConcurrent: 0, duplicateCooldownMs: 60_000 })
  await queue.enqueue({ url: 'https://x/sama', provider: 'instagram', chat: 'c', sender: 'A' })
  await assert.rejects(queue.enqueue({ url: 'https://x/sama', provider: 'instagram', chat: 'c', sender: 'B' }), /sudah ada di antrean #1/)
  await queue.cancel(1, 'A')
  await assert.rejects(queue.enqueue({ url: 'https://x/sama', provider: 'instagram', chat: 'c', sender: 'A' }), /baru saja diproses/)
  const fast = createDownloadQueue({ file: path.join(dir, 'q2.json'), processJob: async () => ({}), maxConcurrent: 0, duplicateCooldownMs: 30 })
  await fast.enqueue({ url: 'https://x/cepat', provider: 'instagram', chat: 'c', sender: 'A' })
  await fast.cancel(1, 'A')
  await assert.rejects(fast.enqueue({ url: 'https://x/cepat', provider: 'instagram', chat: 'c', sender: 'A' }), /baru saja diproses/)
  await new Promise(r => setTimeout(r, 40))
  const ok = await fast.enqueue({ url: 'https://x/cepat', provider: 'instagram', chat: 'c', sender: 'A' })
  assert.equal(ok.job.id, 2, 'setelah cooldown habis, link yang sama boleh mengantri lagi')
})

// ─── Provider sosial: respon senyaman mungkin ───────────────────────────────

function quietConn(events) {
  return {
    sendMessage: async (chat, content) => {
      if (content.react) { events.push({ type: 'react', text: content.react.text, key: content.react.key }); return { key: { id: 'R' } } }
      if (content.delete) { events.push({ type: 'delete', key: content.delete }); return { key: { id: 'D' } } }
      if (content.album) { events.push({ type: 'album', album: content.album }); return { key: { id: 'ALBUM1' } } }
      events.push({ type: 'msg', text: content.text })
      return { key: { id: 'N' + events.length } }
    },
    sendFile: async (chat, source, filename, caption, quoted, ptt, options) => { events.push({ type: 'file', filename, options }) },
  }
}

test('.dl instagram solo: hanya react ⏳, tanpa pesan teks antrean/info', async t => {
  const dir = await tmpDir(t)
  const events = []
  const conn = quietConn(events)
  const registry = { detectProvider: () => 'instagram', getEngine: () => ({ async getInfo() { return { fileName: 'instagram-1', size: 1, downloadUrl: 'u' } }, async download(u, info, { destDir, baseName }) { const p = path.join(destDir, baseName + '.jpg'); await fs.writeFile(p, JPG_BYTES); return { filePath: p, fileName: baseName + '.jpg', mimetype: 'image/jpeg', size: JPG_BYTES.length } } }) }
  const queue = createDownloadQueue({ file: path.join(dir, 'q.json'), processJob: job => runDownloadJob({ conn, job, registry, rootDir: dir }) })
  const replies = []
  const m = { chat: 'c', sender: 'A@s.whatsapp.net', pushName: 'Tes', key: { id: 'U1', remoteJid: 'c', fromMe: false }, conn, quoted: null, reply: async teks => { replies.push(String(teks)) } }
  await downloadHandler(m, { conn, text: 'https://www.instagram.com/p/ABC/', usedPrefix: '.', command: 'dl', downloaderRegistry: registry, downloadQueue: queue })
  assert.deepEqual(replies, [], 'tidak ada balasan teks untuk antrean solo')
  assert.ok(events.some(e => e.type === 'react' && e.text === '⏳'), 'react processing di pesan peminta')
  assert.ok(!events.some(e => e.type === 'msg'), 'belum ada pesan teks apa pun')
  await waitFor(async () => (await queue.snapshot()).jobs.length === 0)
  assert.ok(events.some(e => e.type === 'file'), 'media tetap terkirim')
  assert.ok(events.some(e => e.type === 'react' && e.text === '✅'), 'react diganti centang setelah terkirim')
  assert.ok(!events.some(e => e.type === 'msg' && /Informasi File|selesai/.test(e.text || '')), 'tidak ada pesan info/ringkasan')
})

test('.dl instagram antrean > 1: pesan posisi dikirim lalu dihapus setelah selesai', async t => {
  const dir = await tmpDir(t)
  const events = []
  const conn = quietConn(events)
  const engine = { async getInfo() { return { fileName: 'instagram-1', size: 1, downloadUrl: 'u' } }, async download(u, info, { destDir, baseName }) { const p = path.join(destDir, baseName + '.jpg'); await fs.writeFile(p, JPG_BYTES); return { filePath: p, fileName: baseName + '.jpg', mimetype: 'image/jpeg', size: JPG_BYTES.length } } }
  const registry = { detectProvider: () => 'instagram', getEngine: () => engine }
  // Job pertama sengaja digantung agar antrean benar-benar > 1 saat job IG masuk.
  const queue = createDownloadQueue({ file: path.join(dir, 'q.json'), processJob: job => job.url === 'https://x/dulu' ? new Promise(() => {}) : runDownloadJob({ conn, job, registry, rootDir: dir, getJobState: async id => (await queue.snapshot()).jobs.find(j => j.id === id) ?? null }) })
  await queue.enqueue({ url: 'https://x/dulu', provider: 'pixeldrain', chat: 'c', sender: 'B' })
  const replies = []
  const m = { chat: 'c', sender: 'A@s.whatsapp.net', pushName: 'Tes', key: { id: 'U2', remoteJid: 'c', fromMe: false }, conn, quoted: null, reply: async teks => { replies.push(String(teks)) } }
  await downloadHandler(m, { conn, text: 'https://www.instagram.com/p/ABC/', usedPrefix: '.', command: 'dl', downloaderRegistry: registry, downloadQueue: queue })
  const notice = events.find(e => e.type === 'msg' && /Posisi antrean: 2/.test(e.text || ''))
  assert.ok(notice, 'pesan posisi antrean dikirim karena ada antrean lain')
  await waitFor(async () => (await queue.snapshot()).jobs.every(j => j.url !== 'https://www.instagram.com/p/ABC/'))
  assert.ok(events.some(e => e.type === 'delete'), 'pesan posisi dihapus setelah media terkirim')
  assert.ok(events.some(e => e.type === 'react' && e.text === '✅'))
})

test('runJob quiet: gagal unduh -> react ❌ + pesan gagal, tanpa info', async t => {
  const dir = await tmpDir(t)
  const events = []
  const engine = { async getInfo() { return { fileName: 'instagram-1', size: 1, downloadUrl: 'u' } }, async download() { throw new Error('CDN menolak') } }
  await assert.rejects(runDownloadJob({ conn: quietConn(events), job: { id: 9, url: 'u', provider: 'instagram', chat: 'c', sender: 'A', userMsgKey: { id: 'U9', remoteJid: 'c' }, queueNoticeKey: { id: 'N9', remoteJid: 'c' } }, registry: { getEngine: () => engine }, rootDir: dir }), /CDN menolak/)
  assert.ok(events.some(e => e.type === 'react' && e.text === '❌'), 'react gagal')
  assert.ok(events.some(e => e.type === 'delete'), 'pesan posisi ikut dihapus saat gagal')
  assert.ok(events.some(e => e.type === 'msg' && /gagal/.test(e.text || '')))
  assert.ok(!events.some(e => e.type === 'msg' && /Informasi File/.test(e.text || '')), 'tidak ada pesan info')
})
