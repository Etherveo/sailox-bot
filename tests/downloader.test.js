import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createEngineRegistry, inspectEngine, downloaderRegistry } from '../lib/downloader/registry.js'
import { createDownloadQueue } from '../lib/downloader/queue.js'
import { buildFileName, resolveExtension } from '../lib/downloader/mime.js'
import * as pixeldrain from '../lib/downloader/engines/pixeldrain.js'
import * as mediafire from '../lib/downloader/engines/mediafire.js'
import dlHandler from '../plugins/downloader/download.js'
import pinHandler from '../plugins/downloader/pin.js'
import unduhHandler from '../plugins/downloader/unduh.js'
import saveEngineHandler from '../plugins/owner/saveengine.js'
import getEngineHandler from '../plugins/owner/getengine.js'
import deleteEngineHandler from '../plugins/owner/deleteengine.js'
import listEngineHandler from '../plugins/owner/listengine.js'

// ─── mime ────────────────────────────────────────────────────────────────────

test('mime: buildFileName memakai ekstensi dari mimetype, fallback nama asli', () => {
  assert.equal(buildFileName('lagu', { mimetype: 'audio/mpeg', fileName: 'x.bin' }), 'lagu.mp3')
  assert.equal(buildFileName('arsip', { mimetype: 'application/octet-stream', fileName: 'a.rar' }), 'arsip.rar')
  assert.equal(resolveExtension({ mimetype: '', fileName: '' }), 'bin')
})

// ─── match: host harus domain provider beneran ──────────────────────────────

test('match engine menolak URL pihak lain yang cuma mengandung teks domain', () => {
  assert.equal(pixeldrain.match('https://pixeldrain.com/u/abc'), true)
  assert.equal(pixeldrain.match('https://pixeldrain.com.evil.test/u/abc'), false)
  assert.equal(pixeldrain.match('https://evil.test/?u=pixeldrain.com'), false)
  assert.equal(mediafire.match('https://www.mediafire.com/file/x'), true)
  assert.equal(mediafire.match('https://mediafire.com.evil.test/file/x'), false)
})

// ─── pixeldrain: /l/ (list) ──────────────────────────────────────────────────

const listFixture = {
  success: true,
  id: 'listku',
  title: 'Folder Tes',
  files: [
    { id: 'fA', name: 'satu.mp4', size: 100, mime_type: 'video/mp4' },
    { id: 'fB', name: 'dua.mp4', size: 200, mime_type: 'video/mp4' },
    { id: 'fC', name: 'tiga.mp4', size: 300, mime_type: 'video/mp4' }
  ]
}

function fakeFetchFactory(routes) {
  return async url => {
    const u = String(url)
    for (const [needle, make] of routes) if (u.includes(needle)) return make()
    throw new Error('route tidak dikenal: ' + u)
  }
}

const listFetch = fakeFetchFactory([
  ['/api/list/listku', () => new Response(JSON.stringify(listFixture), { status: 200, headers: { 'content-type': 'application/json' } })],
  ['/api/file/', () => new Response('isi-file', { status: 200, headers: { 'content-type': 'video/mp4' } })]
])

test('pixeldrain /l/ tanpa #item mengembalikan daftar isi list', async () => {
  const info = await pixeldrain.getInfo('https://pixeldrain.com/l/listku', { fetchFn: listFetch })
  assert.equal(info.isList, true)
  assert.equal(info.files.length, 3)
  assert.equal(info.size, 600)
  assert.equal(info.fileUrl, undefined)
})

test('pixeldrain /l/ #item= bersifat 1-based (regresi bug off-by-one legacy)', async () => {
  const first = await pixeldrain.getInfo('https://pixeldrain.com/l/listku#item=1', { fetchFn: listFetch })
  assert.equal(first.fileName, 'satu.mp4')
  assert.equal(first.fileUrl, 'https://pixeldrain.com/api/file/fA')
  const third = await pixeldrain.getInfo('https://pixeldrain.com/l/listku#item=3', { fetchFn: listFetch })
  assert.equal(third.fileName, 'tiga.mp4')
  await assert.rejects(
    pixeldrain.getInfo('https://pixeldrain.com/l/listku#item=4', { fetchFn: listFetch }),
    /Item tidak valid\. Total item: 3/
  )
})

test('pixeldrain download stream ke disk dengan nama dari mimetype', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-pd-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const info = { fileName: 'satu.mp4', fileUrl: 'https://pixeldrain.com/api/file/fA' }
  const result = await pixeldrain.download('https://pixeldrain.com/l/listku#item=1', info, { destDir: dir, baseName: 'satu', fetchFn: listFetch })
  assert.equal(result.fileName, 'satu.mp4')
  assert.equal(result.size, 8)
  assert.equal(await fs.readFile(result.filePath, 'utf8'), 'isi-file')
})

test('pixeldrain download menolak info list tanpa file terpilih', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-pd-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  await assert.rejects(
    pixeldrain.download('https://pixeldrain.com/l/listku', { isList: true, fileName: 'x' }, { destDir: dir, baseName: 'x', fetchFn: listFetch }),
    /Pilih item dulu/
  )
})

// ─── registry: kontrak + hot-reload ──────────────────────────────────────────

const engineCode = versi => `export const id = 'dummy'
export function match(url = '') { return String(url).includes('dummy.test') }
export async function getInfo() { return { fileName: 'd.bin', size: 1, versi: ${versi} } }
export async function download() { throw new Error('tidak dipakai') }
`

test('inspectEngine menolak kode tanpa ekspor wajib', () => {
  assert.throws(() => inspectEngine('export const id = \'x\''), /Ekspor wajib/)
  assert.throws(() => inspectEngine('export default ('), SyntaxError)
  assert.equal(inspectEngine(engineCode(1)).exports.includes('download'), true)
})

test('registry: reload mengambil versi baru tanpa restart; versi rusak tidak menggantikan yang aktif', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-engines-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const registry = createEngineRegistry({ dir, onError: () => {} })

  await fs.writeFile(path.join(dir, 'dummy.js'), engineCode(1))
  await registry.loadAll()
  assert.equal((await registry.get('dummy').getInfo()).versi, 1)

  await fs.writeFile(path.join(dir, 'dummy.js'), engineCode(2))
  const ok = await registry.reload('dummy')
  assert.equal(ok.ok, true)
  assert.equal((await registry.get('dummy').getInfo()).versi, 2, 'hot-reload harus menyajikan versi baru')

  await fs.writeFile(path.join(dir, 'dummy.js'), 'export const id = \'dummy\'\n')
  const bad = await registry.reload('dummy')
  assert.equal(bad.ok, false)
  assert.equal((await registry.get('dummy').getInfo()).versi, 2, 'versi lama harus tetap aktif')
})

test('registry: watcher memuat ulang engine saat file berubah di disk', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-engines-watch-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const registry = createEngineRegistry({ dir, onError: () => {} })
  t.after(() => registry.close())

  await fs.writeFile(path.join(dir, 'dummy.js'), engineCode(1))
  await registry.loadAll()
  registry.watch()

  await fs.writeFile(path.join(dir, 'dummy.js'), engineCode(7))
  const deadline = Date.now() + 5000
  let versi = null
  while (Date.now() < deadline) {
    versi = (await registry.get('dummy').getInfo()).versi
    if (versi === 7) break
    await new Promise(r => setTimeout(r, 100))
  }
  assert.equal(versi, 7)
})

// ─── perintah owner: save/get/list/delete engine ────────────────────────────

test('owner engine CRUD: save (hot-reload) -> list -> get -> delete; kode rusak ditolak sebelum tulis', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-engine-crud-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const registry = createEngineRegistry({ dir, onError: () => {} })
  await registry.loadAll()
  const conn = { role: 'main', sendFile: async () => { throw new Error('tidak dipakai') } }
  const ctx = (command, text) => ({ conn, command, text, args: text ? text.split(/\s+/) : [], downloaderRegistry: registry })
  const fakeM = quoted => {
    const replies = []
    return { chat: 'tes@s.whatsapp.net', quoted, replies, reply: async teks => { replies.push(String(teks)) } }
  }

  const m1 = fakeM({ text: engineCode(3).replaceAll('dummy', 'coba') })
  await saveEngineHandler(m1, ctx('saveengine', 'coba'))
  assert.ok(await fs.stat(path.join(dir, 'coba.js')))
  assert.equal(registry.has('coba'), true, 'engine harus langsung aktif lewat hot-reload')
  assert.match(m1.replies.at(-1), /hot-reload/)

  const m2 = fakeM(null)
  await listEngineHandler(m2, ctx('listengine', ''))
  assert.match(m2.replies.at(-1), /coba/)

  const m3 = fakeM(null)
  await getEngineHandler(m3, ctx('getengine', 'coba'))
  assert.match(m3.replies.at(-1), /export const id = 'coba'/)

  const m4 = fakeM({ text: 'export const id = (' })
  await assert.rejects(saveEngineHandler(m4, ctx('saveengine', 'rusak')), /ditolak/)
  await assert.rejects(fs.stat(path.join(dir, 'rusak.js')))

  const m5 = fakeM(null)
  await deleteEngineHandler(m5, ctx('deleteengine', 'coba'))
  assert.equal(registry.has('coba'), false)
  await assert.rejects(fs.stat(path.join(dir, 'coba.js')))
})

// ─── plugin .unduh dengan engine palsu ───────────────────────────────────────

function fakeConn() {
  const sent = []
  const files = []
  return {
    role: 'main',
    sent,
    files,
    sendMessage: async (chat, content) => { sent.push(content.text ?? '') },
    sendFile: async (chat, filePath, fileName, caption) => { files.push({ filePath, fileName, caption }) }
  }
}

function fakeM() {
  const replies = []
  return { chat: 'tes@s.whatsapp.net', sender: 'founder@s.whatsapp.net', replies, reply: async teks => { replies.push(String(teks)) } }
}

async function setupUnduh(t, fakeEngine) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-unduh-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  global.pluginLoader = { root: path.join(root, 'plugins') }
  t.after(() => { delete global.pluginLoader })
  downloaderRegistry.register('fakehost', fakeEngine)
  t.after(() => downloaderRegistry.unregister('fakehost'))
  return root
}

test('unduh: file kecil terunduh lalu terkirim ke WA via sendFile', async t => {
  const fakeEngine = {
    id: 'fakehost',
    match: url => String(url).includes('fakehost.test'),
    getInfo: async () => ({ fileName: 'contoh.mp4', size: 5, fileUrl: 'https://fakehost.test/f' }),
    download: async (url, info, { destDir }) => {
      const filePath = path.join(destDir, 'contoh.mp4')
      await fs.writeFile(filePath, 'halo!')
      return { filePath, fileName: 'contoh.mp4', mimetype: 'video/mp4', size: 5 }
    }
  }
  const root = await setupUnduh(t, fakeEngine)
  const conn = fakeConn()
  const m = fakeM()
  await unduhHandler(m, { conn, text: 'https://fakehost.test/f', usedPrefix: '.', command: 'unduh' })
  assert.match(conn.sent[0], /Informasi File/)
  assert.equal(conn.files.length, 1)
  assert.equal(conn.files[0].fileName, 'contoh.mp4')
  assert.ok(conn.files[0].filePath.startsWith(path.join(root, 'src', 'downloads', 'fakehost')))
})

test('unduh: file di atas plafon WA tidak dikirim, jalur disk dilaporkan', async t => {
  const bigSize = 151 * 1024 * 1024 // di atas plafon WA 150 MB (lib/simple.js maxMedia)
  const fakeEngine = {
    id: 'fakehost',
    match: url => String(url).includes('fakehost.test'),
    getInfo: async () => ({ fileName: 'besar.bin', size: bigSize, fileUrl: 'https://fakehost.test/big' }),
    download: async (url, info, { destDir }) => {
      const filePath = path.join(destDir, 'besar.bin')
      const fh = await fs.open(filePath, 'w')
      await fh.truncate(bigSize)
      await fh.close()
      return { filePath, fileName: 'besar.bin', mimetype: 'application/octet-stream', size: bigSize }
    }
  }
  await setupUnduh(t, fakeEngine)
  const conn = fakeConn()
  const m = fakeM()
  await unduhHandler(m, { conn, text: 'https://fakehost.test/big', usedPrefix: '.', command: 'u' })
  assert.equal(conn.files.length, 0)
  assert.match(conn.sent.at(-1), /Tidak dikirim ke WA/)
  assert.match(conn.sent.at(-1), /src/)
})

// ─── unduh: baris info + laporan mempra-cek Penjaga Kirim Besar ─────────────
// Regresi 2026-11-06: baris info memvonis "Tidak bisa — melebihi batas
// 150 MB" dari plafon mentah tanpa menanya penjaga, padahal founder
// bisa mengirim sampai 1 GB. Sekarang info mempra-cek (checkBigSend).
const BIG_SIZE = 151 * 1024 * 1024
function bigEngineStopAfterInfo() {
  return {
    id: 'fakehost',
    match: url => String(url).includes('fakehost.test'),
    getInfo: async () => ({ fileName: 'besar.bin', size: BIG_SIZE, fileUrl: 'https://fakehost.test/big' }),
    download: async () => { throw new Error('berhenti sesudah info (tes)') },
  }
}
function founderConn() {
  const c = fakeConn()
  c.identity = { roleOf: () => ({ isFounder: true }) }
  return c
}
function entitleUnduh() {
  global.pluginLoader = { ...global.pluginLoader, get: s => (s === 'downloader/unduh.js' ? unduhHandler : undefined) }
}

test('unduh: info file besar founder yang lolos pra-cek -> "Ya (lewat Penjaga Kirim Besar)"', async t => {
  await setupUnduh(t, bigEngineStopAfterInfo())
  entitleUnduh()
  const conn = founderConn()
  const m = fakeM()
  await unduhHandler(m, { conn, text: 'https://fakehost.test/big', usedPrefix: '.', command: 'u' })
  assert.match(conn.sent[0], /Kirim ke WA: Ya \(lewat Penjaga Kirim Besar\)/)
  assert.doesNotMatch(conn.sent[0], /Tidak bisa/)
})

test('unduh: info file besar saat penjaga menolak keras -> alasannya disebut di muka', async t => {
  await setupUnduh(t, bigEngineStopAfterInfo())
  entitleUnduh()
  globalThis.bigsend = { mode: 'off' }
  t.after(() => { delete globalThis.bigsend })
  const conn = founderConn()
  const m = fakeM()
  await unduhHandler(m, { conn, text: 'https://fakehost.test/big', usedPrefix: '.', command: 'u' })
  assert.match(conn.sent[0], /Tidak bisa — Penjaga Kirim Besar menolak \(mode-off\)/)
})

test('unduh: kirim besar gagal di titik kirim -> laporan menyebut pengiriman gagal, bukan plafon', async t => {
  const fakeEngine = {
    id: 'fakehost',
    match: url => String(url).includes('fakehost.test'),
    getInfo: async () => ({ fileName: 'besar.bin', size: BIG_SIZE, fileUrl: 'https://fakehost.test/big' }),
    download: async (url, info, { destDir }) => {
      const filePath = path.join(destDir, 'besar.bin')
      const fh = await fs.open(filePath, 'w')
      await fh.truncate(BIG_SIZE)
      await fh.close()
      return { filePath, fileName: 'besar.bin', mimetype: 'application/octet-stream', size: BIG_SIZE }
    },
  }
  await setupUnduh(t, fakeEngine)
  entitleUnduh()
  // Tes ini memakai penjaga ASLI (reservasi sungguhan): pulihkan file
  // penanda src/private/send-guard.json ke keadaan semula sesudahnya —
  // tulis penanda dari proses tes bersifat async dan sapuan berkala
  // penjaga tidak berjalan di proses tes, jadi sisa entri bisa tertinggal
  // dan terbaca bot live sebagai "mati di tengah kirim besar".
  const markerPath = path.join(process.cwd(), 'src', 'private', 'send-guard.json')
  const markerBefore = await fs.readFile(markerPath, 'utf8').catch(() => null)
  t.after(async () => {
    if (markerBefore == null) await fs.rm(markerPath, { force: true }).catch(() => {})
    else await fs.writeFile(markerPath, markerBefore).catch(() => {})
  })
  const conn = founderConn()
  let sendAttempts = 0
  conn.sendFile = async () => { sendAttempts++; throw new Error('media ditolak server WA') }
  const m = fakeM()
  await unduhHandler(m, { conn, text: 'https://fakehost.test/big', usedPrefix: '.', command: 'u' })
  assert.equal(sendAttempts, 1, 'error non-koneksi tidak diulang')
  assert.ok(conn.sent.some(s => /⚠️ Gagal mengirim/.test(s)))
  assert.match(conn.sent.at(-1), /Tidak dikirim ke WA: pengiriman gagal/)
  assert.doesNotMatch(conn.sent.at(-1), /melebihi batas/)
})

test('unduh: list tanpa item menampilkan daftar, bukan mengunduh', async t => {
  const fakeEngine = {
    id: 'fakehost',
    match: url => String(url).includes('fakehost.test'),
    getInfo: async () => ({
      isList: true,
      fileName: 'Listku',
      size: 300,
      files: [
        { id: 'a', fileName: 'satu.mp4', size: 100 },
        { id: 'b', fileName: 'dua.mp4', size: 200 }
      ]
    }),
    download: async () => { throw new Error('download tidak boleh dipanggil untuk daftar') }
  }
  await setupUnduh(t, fakeEngine)
  const conn = fakeConn()
  const m = fakeM()
  await unduhHandler(m, { conn, text: 'https://fakehost.test/list', usedPrefix: '.', command: 'unduh' })
  assert.match(m.replies.at(-1), /Isi list/)
  assert.match(m.replies.at(-1), /satu\.mp4/)
  assert.match(m.replies.at(-1), /#item=1/)
})

test('unduh: command u/unduh dan metadata founder', () => {
  assert.match('u', unduhHandler.command)
  assert.match('unduh', unduhHandler.command)
  assert.equal(unduhHandler.founder, true)
  assert.deepEqual(unduhHandler.tags, ['downloader'])
})

// ─── dl/u: daftar provider per baris ────────────────────────────────────────
// Permintaan pemilik 2026-10-25: daftar provider didukung tampil sebagai
// daftar per baris (bullet), bukan dipisah koma. Berlaku untuk pesan usage
// (.dl/.u tanpa link) dan pesan domain tak didukung di kedua plugin.
test('dl/u: daftar provider tampil per baris, bukan dipisah koma', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-providerlist-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  global.pluginLoader = { root: path.join(root, 'plugins') }
  t.after(() => { delete global.pluginLoader })
  const queue = createDownloadQueue({ file: path.join(root, 'q.json'), processJob: async () => ({}) })
  const conn = fakeConn()
  const m = fakeM()
  const checkSection = thrown => {
    const s = typeof thrown === 'string' ? thrown : String(thrown?.message ?? thrown)
    const marker = s.includes('Provider didukung:\n') ? 'Provider didukung:\n' : 'Provider yang didukung:\n'
    const body = s.slice(s.indexOf(marker) + marker.length).split('\n\n')[0]
    const lines = body.split('\n').filter(Boolean)
    assert.ok(lines.length >= 1, 'minimal satu provider tercantum')
    assert.ok(lines.every(l => l.startsWith('• ')), 'setiap baris diawali bullet')
    assert.ok(!body.includes(', '), 'tidak ada pemisah koma di dalam daftar')
  }
  await assert.rejects(dlHandler(m, { conn, text: '', usedPrefix: '.', command: 'dl', downloadQueue: queue }), e => { checkSection(e); return true })
  await assert.rejects(dlHandler(m, { conn, text: 'https://example.invalid/x', usedPrefix: '.', command: 'dl', downloadQueue: queue }), e => { checkSection(e); return true })
  await assert.rejects(unduhHandler(m, { conn, text: '', usedPrefix: '.', command: 'unduh' }), e => { checkSection(e); return true })
  await assert.rejects(unduhHandler(m, { conn, text: 'https://example.invalid/x', usedPrefix: '.', command: 'unduh' }), e => { checkSection(e); return true })
})

// ─── .pin: gerbang Pinterest + delegasi antrean .dl ──────────────────────────
test('pin: link Pinterest masuk antrean, non-Pinterest ditolak, query ditolak jelas', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-pin-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  global.pluginLoader = { root: path.join(root, 'plugins') }
  t.after(() => { delete global.pluginLoader })
  const queue = createDownloadQueue({ file: path.join(root, 'q.json'), processJob: async () => ({}) })
  const conn = fakeConn()
  const m = fakeM()
  await pinHandler(m, { conn, text: 'https://pin.it/abcde', usedPrefix: '.', command: 'pin', downloadQueue: queue })
  assert.match(m.replies.at(-1), /Masuk antrean/)
  assert.match(m.replies.at(-1), /Pinterest/)
  await assert.rejects(pinHandler(m, { conn, text: 'https://example.com/x.jpg', usedPrefix: '.', command: 'pin', downloadQueue: queue }), /bukan Pinterest/)
  await assert.rejects(pinHandler(m, { conn, text: 'wallpaper anime', usedPrefix: '.', command: 'pin', downloadQueue: queue, pinterestSearch: async () => [] }), /ga ketemu/)
  await assert.rejects(pinHandler(m, { conn, text: '', usedPrefix: '.', command: 'pin', downloadQueue: queue }), /\.pin https:\/\/pin\.it/)
  // Tunggu pump antrean selesai (job noop langsung done) sebelum cleanup,
  // kalau tidak rm balapan dengan tulis file antrean.
  for (let i = 0; i < 50; i++) {
    const snap = await queue.snapshot()
    if (!snap.jobs.length) break
    await new Promise(r => setTimeout(r, 20))
  }
})
