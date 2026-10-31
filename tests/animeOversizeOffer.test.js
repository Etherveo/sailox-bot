// tests/animeOversizeOffer.test.js — alur anime: file oversize TIDAK
// diunduh, hanya link yang dikirim (job.linkOnlyIfOversize di
// runDownloadJob), lalu khusus owner/founder dibuka sesi penawaran
// simpan lokal yang dieksekusi lewat teks persis "y" (handler.before
// plugins/anime/pilih.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runDownloadJob } from '../lib/downloader/runJob.js'
import { setFlow, clearFlow, flowKey } from '../lib/helpers/animeFlow.js'
import pilihHandler, { createOversizeOfferStore, OVERSIZE_OFFER_TEXT } from '../plugins/anime/pilih.js'

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-oversize-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

function fakeEngine(events, { size = 500 } = {}) {
  return {
    async getInfo() { events.push('getInfo'); return { fileName: 'ep01.mp4', size, mimetype: 'video/mp4' } },
    async download(url, info, { destDir, baseName }) {
      events.push('download')
      const filePath = path.join(destDir, baseName + '.mp4')
      await fs.writeFile(filePath, 'x'.repeat(10))
      return { filePath, fileName: 'ep01.mp4', mimetype: 'video/mp4', size: 10 }
    },
  }
}
function fakeConn(events) {
  return {
    sendMessage: async (chat, content) => { events.push({ type: 'msg', text: content.text }); return { key: { id: 's1' } } },
    sendFile: async () => { events.push({ type: 'file' }) },
  }
}

// ─── runDownloadJob: gerbang oversize pra-unduh ─────────────────────────────

test('runJob linkOnlyIfOversize: ukuran > plafon -> link saja, download TIDAK dipanggil', async t => {
  const dir = await tmpDir(t)
  const events = []
  const registry = { getEngine: () => fakeEngine(events, { size: 500 }) }
  const result = await runDownloadJob({
    conn: fakeConn(events),
    job: { id: 9, url: 'https://pixeldrain.com/u/big', provider: 'pixeldrain', chat: 'c', sender: 'A', linkOnlyIfOversize: true },
    registry, rootDir: dir, waMaxBytes: 100,
  })
  assert.equal(result.kind, 'link')
  assert.equal(result.reason, 'oversize')
  assert.equal(result.url, 'https://pixeldrain.com/u/big')
  assert.ok(!events.includes('download'), 'download tidak boleh dimulai')
  const msg = events.find(e => e.type === 'msg')
  assert.match(msg.text, /melebihi batas kirim WA/)
  assert.match(msg.text, /https:\/\/pixeldrain\.com\/u\/big/)
})

test('runJob tanpa flag: oversize tetap diunduh lalu disimpan (perilaku lama utuh)', async t => {
  const dir = await tmpDir(t)
  const events = []
  const registry = { getEngine: () => fakeEngine(events, { size: 500 }) }
  const result = await runDownloadJob({
    conn: fakeConn(events),
    job: { id: 10, url: 'https://pixeldrain.com/u/big', provider: 'pixeldrain', chat: 'c', sender: 'A' },
    registry, rootDir: dir, waMaxBytes: 100,
  })
  assert.equal(result.kind, 'file')
  assert.ok(events.includes('download'))
})

test('runJob linkOnlyIfOversize: ukuran tidak diketahui (null) -> unduh normal', async t => {
  const dir = await tmpDir(t)
  const events = []
  const registry = { getEngine: () => fakeEngine(events, { size: null }) }
  const result = await runDownloadJob({
    conn: fakeConn(events),
    job: { id: 11, url: 'https://pixeldrain.com/u/x', provider: 'pixeldrain', chat: 'c', sender: 'A', linkOnlyIfOversize: true },
    registry, rootDir: dir, waMaxBytes: 100,
  })
  assert.equal(result.kind, 'file')
  assert.ok(events.includes('download'))
})

// ─── Store penawaran ────────────────────────────────────────────────────────

test('oversize offer store: put/get/delete + kedaluwarsa malas', () => {
  let nowVal = 1000
  const store = createOversizeOfferStore({ ttlMs: 1000, now: () => nowVal })
  store.put('c', 'A', { provider: 'pixeldrain', url: 'u' })
  assert.equal(store.get('c', 'A')?.provider, 'pixeldrain')
  assert.equal(store.get('c', 'B'), null, 'sender lain tidak ikut')
  nowVal = 2500
  assert.equal(store.get('c', 'A'), null, 'kedaluwarsa malas')
  store.put('c', 'A', { provider: 'pixeldrain', url: 'u' })
  store.delete('c', 'A')
  assert.equal(store.get('c', 'A'), null)
})

// ─── Plugin .pilih: tawaran dibuka sesudah link oversize ────────────────────

function fakeMsg(over = {}) {
  const replies = []
  const m = {
    chat: '62823@s.whatsapp.net', sender: '62823@s.whatsapp.net', pushName: 'Veo',
    text: '1', fromMe: false, key: { remoteJid: '62823@s.whatsapp.net', id: 'm1' },
    reply: async t => { replies.push(String(t)) },
    ...over,
  }
  m.replies = replies
  return m
}

function seedProvidersFlow(m) {
  setFlow(flowKey(m), {
    stage: 'providers', title: 'Ep 1', episodeUrl: 'https://kuramanime.example/episode/1',
    items: [{ url: 'https://pixeldrain.com/u/abc', quality: '720p', text: 'Pixeldrain' }],
  })
}

test('pilih: hasil link-oversize -> penawaran dibuka untuk founder + teks tawaran terkirim', async () => {
  const m = fakeMsg()
  seedProvidersFlow(m)
  const store = createOversizeOfferStore()
  let seenJob = null
  const ctx = {
    conn: fakeConn([]), text: '1', usedPrefix: '.', command: 'pilih', isFounder: true, isOwner: true,
    oversizeOffers: store,
    runDownloadJob: async ({ job }) => { seenJob = job; return { kind: 'link', reason: 'oversize', provider: job.provider, url: job.url, fileName: 'ep01.mp4', size: 999 } },
  }
  await pilihHandler(m, ctx)
  assert.equal(seenJob.linkOnlyIfOversize, true, 'job alur anime memasang flag')
  assert.equal(store.get(m.chat, m.sender)?.provider, 'pixeldrain')
  assert.ok(m.replies.includes(OVERSIZE_OFFER_TEXT))
  clearFlow(flowKey(m))
})

test('pilih: hasil link-oversize untuk NON-owner -> tidak ada penawaran', async () => {
  const m = fakeMsg()
  seedProvidersFlow(m)
  const store = createOversizeOfferStore()
  const ctx = {
    conn: fakeConn([]), text: '1', usedPrefix: '.', command: 'pilih', isFounder: false, isOwner: false,
    oversizeOffers: store,
    runDownloadJob: async ({ job }) => ({ kind: 'link', reason: 'oversize', provider: job.provider, url: job.url, fileName: 'ep01.mp4', size: 999 }),
  }
  await pilihHandler(m, ctx)
  assert.equal(store.get(m.chat, m.sender), null)
  assert.ok(!m.replies.includes(OVERSIZE_OFFER_TEXT))
  clearFlow(flowKey(m))
})

// ─── handler.before: eksekusi "y" ───────────────────────────────────────────

test('before: "y" dari owner mengeksekusi simpan lokal (tanpa flag), sesi ditutup', async () => {
  const store = createOversizeOfferStore()
  store.put('c1', 'A', { provider: 'pixeldrain', url: 'https://pixeldrain.com/u/abc' })
  let seenJob = null
  const m = fakeMsg({ chat: 'c1', sender: 'A', text: 'y' })
  const ctx = { conn: fakeConn([]), isFounder: true, isOwner: true, oversizeOffers: store, runDownloadJob: async ({ job }) => { seenJob = job; return { kind: 'file' } } }
  assert.equal(await pilihHandler.before(m, ctx), true)
  assert.equal(seenJob.provider, 'pixeldrain')
  assert.equal(seenJob.linkOnlyIfOversize, undefined, 'job simpan lokal TIDAK memasang flag link-only')
  assert.equal(store.get('c1', 'A'), null, 'sesi sekali pakai')
  assert.match(m.replies.at(-1), /tidak ditemukan di disk/, 'tanpa filePath hasil -> upload dilewati dengan penjelasan')
})

// ─── handler.before: upload ke Drive sesudah simpan lokal ───────────────────

async function beforeWithUpload(t, uploadImpl) {
  const dir = await tmpDir(t)
  const filePath = path.join(dir, 'ep01.mp4')
  await fs.writeFile(filePath, 'x'.repeat(10))
  const store = createOversizeOfferStore()
  store.put('c1', 'A', { provider: 'pixeldrain', url: 'https://pixeldrain.com/u/abc' })
  const m = fakeMsg({ chat: 'c1', sender: 'A', text: 'y' })
  const ctx = {
    conn: fakeConn([]), isFounder: true, isOwner: true, oversizeOffers: store,
    runDownloadJob: async () => ({ kind: 'file', fileName: 'ep01.mp4', size: 10, filePath }),
    uploadToDrive: uploadImpl,
  }
  assert.equal(await pilihHandler.before(m, ctx), true)
  return m
}

test('before: sesudah simpan, file di-upload ke Drive dan link-nya dilaporkan', async t => {
  let uploadedPath = null
  const m = await beforeWithUpload(t, async p => { uploadedPath = p; return { status: 'uploaded', fileName: 'ep01.mp4', size: 10, webViewLink: 'https://drive.google.com/file/d/XYZ/view' } })
  assert.ok(uploadedPath?.endsWith('ep01.mp4'))
  assert.ok(m.replies.some(r => /Mengunggah ke Google Drive/.test(r)))
  assert.ok(m.replies.some(r => /Upload ke Drive selesai/.test(r) && /drive\.google\.com/.test(r)))
})

test('before: nama sama di Drive -> upload dilewati, dilaporkan apa adanya', async t => {
  const m = await beforeWithUpload(t, async () => ({ status: 'skipped', reason: 'File dengan nama sama sudah ada di folder tujuan.', fileName: 'ep01.mp4' }))
  assert.ok(m.replies.some(r => /Upload Drive dilewati/.test(r) && /nama sama/.test(r)))
})

test('before: upload gagal -> simpan lokal tetap sah, kegagalan dilaporkan mentah', async t => {
  const m = await beforeWithUpload(t, async () => { throw new Error('token Drive kedaluwarsa') })
  assert.ok(m.replies.some(r => /upload ke Drive gagal/.test(r) && /token Drive kedaluwarsa/.test(r)))
})

test('before: "y" dari non-owner ditolak walau sesi ada', async () => {
  const store = createOversizeOfferStore()
  store.put('c1', 'A', { provider: 'pixeldrain', url: 'u' })
  let ran = false
  const m = fakeMsg({ chat: 'c1', sender: 'A', text: 'Y' })
  const ctx = { conn: fakeConn([]), isFounder: false, isOwner: false, oversizeOffers: store, runDownloadJob: async () => { ran = true } }
  assert.equal(await pilihHandler.before(m, ctx), false)
  assert.equal(ran, false)
  assert.ok(store.get('c1', 'A'), 'sesi tidak disentuh')
})

test('before: tanpa sesi / teks bukan "y" persis -> dilewati', async () => {
  const store = createOversizeOfferStore()
  const ctx = { conn: fakeConn([]), isFounder: true, oversizeOffers: store, runDownloadJob: async () => { throw new Error('tidak boleh jalan') } }
  assert.equal(await pilihHandler.before(fakeMsg({ chat: 'c1', sender: 'A', text: 'y' }), ctx), false, 'tanpa sesi')
  store.put('c1', 'A', { provider: 'pixeldrain', url: 'u' })
  assert.equal(await pilihHandler.before(fakeMsg({ chat: 'c1', sender: 'A', text: 'yes' }), ctx), false, '"yes" bukan "y"')
  assert.equal(await pilihHandler.before(fakeMsg({ chat: 'c1', sender: 'A', text: 'y', fromMe: true }), ctx), false, 'pesan bot sendiri')
})
