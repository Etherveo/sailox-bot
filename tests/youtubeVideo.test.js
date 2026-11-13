// tests/youtubeVideo.test.js — dukungan VIDEO YouTube (.dl) + gerbang
// audio .play + sesi pilih resolusi + gerbang opsi job runJob + store
// sesi generik. Semua tanpa jaringan nyata: fetch stub, antrean nyata
// (processJob pencatat), fake socket dari fixtures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import * as youtube from '../lib/downloader/engines/youtube.js'
import { createSessionStore } from '../lib/helpers/sessionStore.js'
import { runDownloadJob, formatDurationSec } from '../lib/downloader/runJob.js'
import { createDownloadQueue } from '../lib/downloader/queue.js'
import { createEngineRegistry } from '../lib/downloader/registry.js'
import { fakeConn } from './fixtures.js'
import dlHandler, { ytResolutionSessions, createYtResolutionStore } from '../plugins/downloader/download.js'
import playHandler, { playJobOptions } from '../plugins/downloader/play.js'

// Kunci protokol savetube — SAMA seperti di engine (duplikat dari
// tests/youtube.test.js supaya perubahan kunci ketahuan tes ini juga).
const SAVETUBE_KEY = 'C5D58EF67A7584E4A29F6C35BBC4EB12'

function encryptSavetubePayload(obj) {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(SAVETUBE_KEY, 'hex'), iv)
  return Buffer.concat([iv, cipher.update(JSON.stringify(obj)), cipher.final()]).toString('base64')
}

const VIDEO_ID = 'dQw4w9WgXcQ'
const WATCH = `https://www.youtube.com/watch?v=${VIDEO_ID}`
const SHORT = `https://youtu.be/${VIDEO_ID}`

const VIDEO_INFO_PAYLOAD = {
  title: 'Video Tes (Official)',
  duration: 214,
  key: 'kunci123',
  video_formats: [
    { height: 360, url: 'https://x/360' },
    { height: 720, url: 'https://x/720' },
    { height: 1080, url: 'https://x/1080' },
    { height: 2160, url: 'https://x/2160' },
    { height: 144, url: 'https://x/144' },
  ],
  audio_formats: [{ quality: 128 }],
}

// Stub savetube untuk video: /download bisa digagalkan per kualitas
// (downloadByQuality[q] === false -> 500), HEAD bisa digagalkan
// (headSize null -> throw, simulasi HEAD tidak bisa dipegang), GET
// rentang mengembalikan total dari content-range (rangeSize null ->
// throw, simulasi keduanya gagal).
function savetubeVideoFetch({ infoPayload = VIDEO_INFO_PAYLOAD, downloadByQuality = {}, headSize = 21_000_000, rangeSize = null } = {}) {
  return async (url, opts = {}) => {
    const u = String(url)
    if (u.includes('random-cdn')) {
      return new Response(JSON.stringify({ cdn: 'cdn999.savetube.vip' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.includes('/v2/info')) {
      return new Response(JSON.stringify({ data: encryptSavetubePayload(infoPayload) }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.includes('/download')) {
      const body = JSON.parse(opts.body || '{}')
      if (downloadByQuality[body.quality] === false) {
        return new Response(JSON.stringify({ error: 'tidak ada' }), { status: 500, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ data: { downloadUrl: `https://cdn999.savetube.vip/media/v${body.quality}.mp4` } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.includes('cdn999.savetube.vip/media/')) {
      if (opts.method === 'HEAD') {
        if (headSize == null) throw new Error('fetch failed')
        return new Response(null, { status: 200, headers: { 'content-length': String(headSize) } })
      }
      if (rangeSize == null) throw new Error('fetch failed')
      return new Response(new Uint8Array([0]), { status: 206, headers: { 'content-range': `bytes 0-0/${rangeSize}` } })
    }
    throw new Error('route tidak dikenal: ' + u)
  }
}

// ─── parseYtRequest / buildYtJobUrl / availableVideoQualities ──────────────

test('youtube video: parseYtRequest + buildYtJobUrl bolak-balik, default audio', () => {
  assert.deepEqual(youtube.parseYtRequest(`${SHORT}#yt=video:480`), { videoId: VIDEO_ID, kind: 'video', quality: 480 })
  assert.deepEqual(youtube.parseYtRequest(`${SHORT}#yt=video:1080`), { videoId: VIDEO_ID, kind: 'video', quality: 1080 })
  assert.deepEqual(youtube.parseYtRequest(`${SHORT}#yt=audio`), { videoId: VIDEO_ID, kind: 'audio', quality: 720 })
  assert.deepEqual(youtube.parseYtRequest(SHORT), { videoId: VIDEO_ID, kind: 'audio', quality: 720 })
  assert.deepEqual(youtube.parseYtRequest(`${SHORT}#yt=video:9999`), { videoId: VIDEO_ID, kind: 'video', quality: 720 }, 'resolusi di luar daftar -> default 720p')
  assert.equal(youtube.parseYtRequest('https://www.youtube.com/'), null)
  assert.equal(youtube.buildYtJobUrl(VIDEO_ID, 'video', 480), `${SHORT}#yt=video:480`)
  assert.equal(youtube.buildYtJobUrl(VIDEO_ID, 'audio'), SHORT)
  assert.deepEqual(youtube.parseYtRequest(youtube.buildYtJobUrl(VIDEO_ID, 'video', 720)), { videoId: VIDEO_ID, kind: 'video', quality: 720 })
})

test('youtube video: availableVideoQualities hanya 360-1080, tanpa duplikat, urut naik', () => {
  assert.deepEqual(youtube.availableVideoQualities(VIDEO_INFO_PAYLOAD), [360, 720, 1080])
  assert.deepEqual(youtube.availableVideoQualities({ video_formats: [{ height: 1080 }, { height: 1080 }, { height: 480 }] }), [480, 1080])
  assert.deepEqual(youtube.availableVideoQualities({}), [])
  assert.deepEqual(youtube.availableVideoQualities(null), [])
})

// ─── probeSize ─────────────────────────────────────────────────────────────

test('youtube probeSize: HEAD dulu, lalu GET rentang, lalu null', async () => {
  const url = 'https://cdn999.savetube.vip/media/v720.mp4'
  assert.equal(await youtube.probeSize(url, { fetchFn: savetubeVideoFetch({ headSize: 21_000_000 }) }), 21_000_000)
  assert.equal(await youtube.probeSize(url, { fetchFn: savetubeVideoFetch({ headSize: null, rangeSize: 9_174_812 }) }), 9_174_812, 'HEAD gagal -> total dari content-range')
  assert.equal(await youtube.probeSize(url, { fetchFn: savetubeVideoFetch({ headSize: null, rangeSize: null }) }), null, 'keduanya gagal -> ukuran tidak diketahui')
})

// ─── getInfo video + getVideoQualities ─────────────────────────────────────

test('youtube getInfo video: 720p default + metadata + kualitas tersedia', async () => {
  const info = await youtube.getInfo(`${SHORT}#yt=video:720`, { fetchFn: savetubeVideoFetch({}) })
  assert.equal(info.fileName, 'Video Tes (Official).mp4')
  assert.equal(info.mimetype, 'video/mp4')
  assert.equal(info.size, 21_000_000)
  assert.equal(info.downloadUrl, 'https://cdn999.savetube.vip/media/v720.mp4')
  assert.equal(info.duration, 214)
  assert.equal(info.videoId, VIDEO_ID)
  assert.equal(info.kind, 'video')
  assert.equal(info.quality, 720)
  assert.equal(info.requestedQuality, 720)
  assert.equal(info.fallback, false)
  assert.deepEqual(info.availableQualities, [360, 720, 1080])
})

test('youtube getInfo video: fallback 1080 -> 720, lalu 720 gagal -> 480', async () => {
  const info = await youtube.getInfo(`${SHORT}#yt=video:1080`, { fetchFn: savetubeVideoFetch({ downloadByQuality: { 1080: false } }) })
  assert.equal(info.quality, 720)
  assert.equal(info.requestedQuality, 1080)
  assert.equal(info.fallback, true)
  assert.equal(info.downloadUrl, 'https://cdn999.savetube.vip/media/v720.mp4')
  const info2 = await youtube.getInfo(`${SHORT}#yt=video:1080`, { fetchFn: savetubeVideoFetch({ downloadByQuality: { 1080: false, 720: false } }) })
  assert.equal(info2.quality, 480, '720p pun tidak ada -> tertinggi di bawah yang diminta')
  assert.equal(info2.fallback, true)
  await assert.rejects(
    youtube.getInfo(`${SHORT}#yt=video:360`, { fetchFn: savetubeVideoFetch({ downloadByQuality: { 360: false, 720: false } }) }),
    /tidak tersedia/,
    'semua kandidat gagal -> ditolak jelas',
  )
})

test('youtube getVideoQualities: daftar resolusi dari /v2/info', async () => {
  assert.deepEqual(await youtube.getVideoQualities(WATCH, { fetchFn: savetubeVideoFetch({}) }), [360, 720, 1080])
  await assert.rejects(youtube.getVideoQualities('https://www.youtube.com/', { fetchFn: savetubeVideoFetch({}) }), /tidak valid/)
})

// ─── store sesi generik ─────────────────────────────────────────────────────

function fakeTimers() {
  const timers = new Map()
  let nextId = 1
  return {
    setTimeoutFn: (fn, ms) => { const id = nextId++; const t = { id, unref() {} }; timers.set(id, { fn, ms }); return t },
    clearTimeoutFn: t => { timers.delete(t?.id) },
    fireAll: () => { for (const { fn } of [...timers.values()]) fn(); timers.clear() },
    get size() { return timers.size },
  }
}

test('sessionStore: put/get/delete, TTL malas, onExpire via timer, delete bersihkan timer', () => {
  let now = 1000
  const timers = fakeTimers()
  const store = createSessionStore({ ttlMs: 30_000, now: () => now, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn })
  let expired = 0
  store.put('c1', 'S', { v: 1 }, () => { expired++ })
  assert.equal(store.get('c1', 'S').v, 1)
  assert.equal(store.get('c2', 'S'), null, 'chat lain tidak ikut terpicu')
  assert.equal(timers.size, 1, 'satu timer per sesi')
  // Dipakai sebelum habis -> timer dibersihkan, onExpire tidak jalan.
  store.delete('c1', 'S')
  assert.equal(timers.size, 0)
  timers.fireAll()
  assert.equal(expired, 0, 'timer yang dibersihkan tidak boleh jalan')
  // Timeout -> onExpire jalan sekali.
  store.put('c1', 'S', { v: 2 }, () => { expired++ })
  assert.equal(timers.size, 1)
  timers.fireAll()
  assert.equal(expired, 1)
  assert.equal(store.get('c1', 'S'), null, 'entri hilang sesudah timeout')
  // Tanpa onExpire: tanpa timer, kedaluwarsa malas seperti store lama.
  store.put('c1', 'S', { v: 3 })
  assert.equal(timers.size, 0)
  now += 29_000
  assert.ok(store.get('c1', 'S'), 'masih hidup sebelum TTL')
  now += 1000
  assert.equal(store.get('c1', 'S'), null, 'kedaluwarsa setelah TTL')
  // Kedaluwarsa malas juga menjalankan onExpire (ditemukan saat dibaca).
  store.put('c1', 'S', { v: 4 }, () => { expired++ })
  now += 30_000
  assert.equal(store.get('c1', 'S'), null)
  assert.equal(expired, 2, 'onExpire jalan juga saat kedaluwarsa ditemukan malas')
  assert.equal(timers.size, 0, 'timer kedaluwarsa malas ikut dibersihkan')
  assert.throws(() => createSessionStore({}), /ttlMs positif/)
})

// ─── pembantu antrean + pesan ───────────────────────────────────────────────

async function fakeQueueWithCapture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-ytv-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  global.pluginLoader = { root: path.join(root, 'plugins') }
  t.after(() => { delete global.pluginLoader })
  const processed = []
  const queue = createDownloadQueue({ file: path.join(root, 'q.json'), processJob: async job => { processed.push(job); return {} } })
  return { root, queue, processed }
}

async function waitForProcessed(processed, n = 1) {
  for (let i = 0; i < 100; i++) {
    if (processed.length >= n) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('job tidak diproses antrean')
}

function fakeM() {
  const replies = []
  return {
    chat: 'tes@s.whatsapp.net',
    sender: 'founder@s.whatsapp.net',
    pushName: 'V',
    key: { id: 'm1', remoteJid: 'tes@s.whatsapp.net', fromMe: false },
    replies,
    reply: async teks => { replies.push(String(teks)) },
  }
}

const SEARCH_FOUND = { videoId: VIDEO_ID, title: 'Rick Astley - Never Gonna Give You Up (Official Video)', url: SHORT, seconds: 213, views: 1234567, ago: '15 years ago', author: { name: 'Rick Astley' } }

// ─── .play: alias, -d, durasi ───────────────────────────────────────────────

test('play: alias yta/ytmp3/mp3 sama seperti .play; jobOptions gerbang diteruskan ke antrean', async t => {
  const { queue, processed } = await fakeQueueWithCapture(t)
  const conn = fakeConn()
  // Tiap alias memakai video berbeda — antrean mendedupe URL yang sama.
  const ids = ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC']
  let n = 0
  const searchYouTube = async () => {
    const id = ids[n++]
    return { ...SEARCH_FOUND, videoId: id, url: `https://youtu.be/${id}` }
  }
  for (const alias of ['yta', 'ytmp3', 'mp3']) {
    const m = fakeM()
    await playHandler(m, { conn, text: 'rick astley', usedPrefix: '.', command: alias, downloadQueue: queue, searchYouTube })
    assert.match(m.replies.at(-1), /Masuk antrean/)
  }
  assert.match('yta', playHandler.command)
  assert.match('ytmp3', playHandler.command)
  assert.match('mp3', playHandler.command)
  await waitForProcessed(processed, 3)
  for (const job of processed) {
    assert.equal(job.provider, 'youtube')
    assert.equal(job.options.forceDocument, false)
    assert.equal(job.options.docAboveBytes, 15 * 1024 * 1024)
    assert.equal(job.options.maxDurationSec, 3600)
    assert.equal(job.options.maxSizeBytes, 500 * 1024 * 1024)
  }
  assert.deepEqual(playJobOptions({ forceDocument: true }).forceDocument, true)
})

test('play: flag -d di mana saja -> forceDocument, query pencarian dibersihkan dari -d', async t => {
  const { queue, processed } = await fakeQueueWithCapture(t)
  const conn = fakeConn()
  const queries = []
  const m = fakeM()
  await playHandler(m, { conn, text: 'rick astley -d', usedPrefix: '.', command: 'play', downloadQueue: queue, searchYouTube: async q => { queries.push(q); return SEARCH_FOUND } })
  assert.deepEqual(queries, ['rick astley'], '-d tidak boleh ikut jadi kata kunci')
  await waitForProcessed(processed, 1)
  assert.equal(processed[0].options.forceDocument, true)
  const m2 = fakeM()
  await playHandler(m2, { conn, text: '-d https://youtu.be/BBBBBBBBBBB', usedPrefix: '.', command: 'play', downloadQueue: queue })
  await waitForProcessed(processed, 2)
  assert.equal(processed[1].options.forceDocument, true, '-d di depan link juga dibaca')
  assert.equal(processed[1].url, 'https://youtu.be/BBBBBBBBBBB')
})

test('play: durasi hasil pencarian >1 jam ditolak SEBELUM antre', async t => {
  const { queue, processed } = await fakeQueueWithCapture(t)
  const conn = fakeConn()
  const long = { ...SEARCH_FOUND, seconds: 3601, title: 'Video Panjang Sekali' }
  await assert.rejects(
    playHandler(fakeM(), { conn, text: 'video panjang', usedPrefix: '.', command: 'play', downloadQueue: queue, searchYouTube: async () => long }),
    /melebihi batas 1 jam/,
  )
  await new Promise(r => setTimeout(r, 100))
  assert.equal(processed.length, 0, 'tidak ada job yang masuk antrean')
  await assert.rejects(
    playHandler(fakeM(), { conn, text: '-d', usedPrefix: '.', command: 'play', downloadQueue: queue }),
    /-d/,
    'usage menyebut -d',
  )
})

// ─── .dl YouTube: resolusi di teks, sesi tawaran, timeout ───────────────────

test('dl youtube: resolusi di teks -> antre langsung dengan fragmen + gerbang dokumen', async t => {
  const { queue, processed } = await fakeQueueWithCapture(t)
  const conn = fakeConn()
  const m = fakeM()
  await dlHandler(m, { conn, text: `${WATCH} 1080p`, usedPrefix: '.', command: 'dl', downloadQueue: queue })
  assert.match(m.replies.at(-1), /Masuk antrean #1/)
  await waitForProcessed(processed, 1)
  assert.equal(processed[0].url, `${SHORT}#yt=video:1080`)
  assert.equal(processed[0].provider, 'youtube')
  assert.equal(processed[0].options.forceDocument, false)
  assert.equal(processed[0].options.docAboveBytes, 50 * 1024 * 1024)
  assert.equal(processed[0].options.docAboveDurationSec, 600)
  assert.equal(processed[0].options.docIfResolutionAtLeast, 720)
  assert.equal(ytResolutionSessions.size, 0, 'resolusi eksplisit tidak membuka sesi')
})

test('dl youtube: tanpa resolusi -> tawaran 30 detik; balas 480p -> antre 480p + tawaran dihapus', async t => {
  const { queue, processed } = await fakeQueueWithCapture(t)
  const conn = fakeConn()
  const m = fakeM()
  await dlHandler(m, { conn, text: WATCH, usedPrefix: '.', command: 'dl', downloadQueue: queue, getVideoQualities: async () => [360, 480, 720, 1080] })
  // Tawaran dikirim lewat conn.sendMessage (bukan m.reply) — kunci
  // pesannya tersimpan di sesi.
  const offerCall = conn.calls.find(c => typeof c.data?.text === 'string' && c.data.text.includes('Pilih resolusi'))
  assert.ok(offerCall, 'pesan tawaran terkirim')
  assert.match(offerCall.data.text, /360p • 480p • 720p \(default\) • 1080p/)
  assert.match(offerCall.data.text, /30 detik/)
  assert.equal(processed.length, 0, 'belum ada job sebelum memilih')
  const offerKey = ytResolutionSessions.get(m.chat, m.sender)?.offerKey
  assert.ok(offerKey, 'kunci pesan tawaran disimpan di sesi')
  // Balasan dari pengirim lain / chat lain tidak terpicu.
  const mOther = { ...fakeM(), sender: 'orang-lain@s.whatsapp.net', text: '480p' }
  assert.equal(await dlHandler.before(mOther, { conn, downloadQueue: queue }), false)
  assert.equal(processed.length, 0)
  // Pemilik sesi membalas 480p -> antre 480p, tawaran dihapus.
  const mPick = { ...fakeM(), text: '480p' }
  assert.equal(await dlHandler.before(mPick, { conn, downloadQueue: queue }), true)
  const deleteCall = conn.calls.find(c => c.data?.delete)
  assert.ok(deleteCall, 'pesan tawaran dihapus setelah dipilih')
  assert.deepEqual(deleteCall.data.delete, offerKey)
  await waitForProcessed(processed, 1)
  assert.equal(processed[0].url, `${SHORT}#yt=video:480`)
  assert.equal(ytResolutionSessions.get(m.chat, m.sender), null, 'sesi tertutup setelah dipilih')
  // Balasan kedua tidak bereaksi lagi.
  assert.equal(await dlHandler.before({ ...fakeM(), text: '720p' }, { conn, downloadQueue: queue }), false)
})

test('dl youtube: timeout sesi -> antre 720p (default) + tawaran dihapus', async t => {
  const { queue, processed } = await fakeQueueWithCapture(t)
  const conn = fakeConn()
  const timers = fakeTimers()
  const sessions = createYtResolutionStore({ ttlMs: 30_000, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn })
  const m = fakeM()
  await dlHandler(m, { conn, text: WATCH, usedPrefix: '.', command: 'dl', downloadQueue: queue, getVideoQualities: async () => [360, 720], ytResolutionSessions: sessions })
  assert.equal(sessions.size, 1)
  assert.equal(processed.length, 0)
  const offerKey = sessions.get(m.chat, m.sender)?.offerKey
  assert.ok(offerKey)
  timers.fireAll()
  // onExpire async + antrean keluar socket (OutboundQueue) butuh satu
  // putaran event loop sebelum panggilan sendMessage tercatat.
  await new Promise(r => setTimeout(r, 50))
  assert.equal(sessions.size, 0, 'sesi hilang sesudah timeout')
  const deleteCall = conn.calls.find(c => c.data?.delete)
  assert.ok(deleteCall, 'pesan tawaran dihapus saat timeout')
  assert.deepEqual(deleteCall.data.delete, offerKey)
  await waitForProcessed(processed, 1)
  assert.equal(processed[0].url, `${SHORT}#yt=video:720`, 'timeout -> 720p default')
  const timeoutMsg = conn.calls.find(c => typeof c.data?.text === 'string' && c.data.text.includes('Waktu memilih resolusi habis'))
  assert.ok(timeoutMsg, 'user diberi tahu timeout + default')
})

test('dl youtube: getVideoQualities gagal -> tawarkan semua resolusi', async t => {
  const { queue } = await fakeQueueWithCapture(t)
  const conn = fakeConn()
  const m = fakeM()
  await dlHandler(m, { conn, text: WATCH, usedPrefix: '.', command: 'dl', downloadQueue: queue, getVideoQualities: async () => { throw new Error('savetube down') } })
  const offerCall = conn.calls.find(c => typeof c.data?.text === 'string' && c.data.text.includes('Pilih resolusi'))
  assert.match(offerCall.data.text, /360p • 480p • 720p \(default\) • 1080p/)
  // Bersihkan sesi yang terbuka supaya tidak bocor ke tes lain.
  ytResolutionSessions.delete(m.chat, m.sender)
})

test('dl: provider lain tidak kena sesi resolusi YouTube', async t => {
  const { queue, processed } = await fakeQueueWithCapture(t)
  const conn = fakeConn()
  const m = fakeM()
  await dlHandler(m, { conn, text: 'https://pixeldrain.com/u/abc123', usedPrefix: '.', command: 'dl', downloadQueue: queue })
  assert.match(m.replies.at(-1), /Masuk antrean/)
  await waitForProcessed(processed, 1)
  assert.equal(processed[0].provider, 'pixeldrain')
  // Antrean menormalisasi options undefined -> null (queue.js), jadi baca
  // dengan ?. : yang dijamin adalah tidak ada flag sesi di job ini.
  assert.equal(processed[0].options?.pickSession, undefined)
  assert.equal(ytResolutionSessions.size, 0)
})

// ─── gerbang opsi job runJob ────────────────────────────────────────────────

function fakeYtEngine({ info, downloadSize = 5 }) {
  let downloads = 0
  const mp4Head = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112])
  return {
    engine: {
      id: 'youtube',
      match: url => String(url).includes('youtu'),
      getInfo: async () => info,
      download: async (url, infoArg, { destDir }) => {
        downloads++
        const filePath = path.join(destDir, 'video.mp4')
        const body = Buffer.alloc(downloadSize)
        mp4Head.copy(body)
        await fs.writeFile(filePath, body)
        return { filePath, fileName: 'video.mp4', mimetype: 'video/mp4', size: downloadSize }
      },
    },
    get downloads() { return downloads },
  }
}

async function runJobCase(t, { options, info, downloadSize = 5 }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-ytjob-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const registry = createEngineRegistry({ dir: path.join(root, 'engines'), onError: () => {} })
  const fake = fakeYtEngine({ info, downloadSize })
  registry.register('youtube', fake.engine)
  const sent = []
  const files = []
  const conn = {
    role: 'main', sent, files,
    sendMessage: async (chat, content) => { sent.push(content.text ?? '') },
    sendFile: async (chat, filePath, fileName, caption, quoted, ptt, opts) => { files.push({ filePath, fileName, caption, options: opts }) },
  }
  const job = { id: 1, url: `${SHORT}#yt=video:720`, provider: 'youtube', chat: 'tes@s.whatsapp.net', sender: 'founder@s.whatsapp.net', senderName: 'V', userMsgKey: null, options }
  return {
    root, conn, job, sent, files,
    get downloads() { return fake.downloads },
    run: () => runDownloadJob({ conn, job, registry, rootDir: root }),
  }
}

test('runJob gerbang: durasi > batas ditolak SEBELUM unduh', async t => {
  const c = await runJobCase(t, {
    options: { maxDurationSec: 3600 },
    info: { fileName: 'video.mp4', size: 1000, mimetype: 'video/mp4', downloadUrl: 'https://x/v.mp4', duration: 3601, quality: 720 },
  })
  await assert.rejects(c.run(), /melebihi batas/)
  assert.equal(c.downloads, 0, 'tidak ada byte yang diunduh sia-sia')
  assert.ok(c.sent.some(s => /ditolak/.test(s) && /Durasi/.test(s)), 'user diberi tahu alasan tolak')
  assert.equal(c.files.length, 0)
})

test('runJob gerbang: ukuran diketahui > batas ditolak SEBELUM unduh', async t => {
  const c = await runJobCase(t, {
    options: { maxSizeBytes: 500 * 1024 * 1024 },
    info: { fileName: 'video.mp4', size: 501 * 1024 * 1024, mimetype: 'video/mp4', downloadUrl: 'https://x/v.mp4', duration: 100, quality: 720 },
  })
  await assert.rejects(c.run(), /melebihi batas/)
  assert.equal(c.downloads, 0)
  assert.ok(c.sent.some(s => /ditolak/.test(s) && /Ukuran/.test(s)))
})

test('runJob gerbang: ukuran tak diketahui (null) -> unduh dulu, tolak + hapus SEBELUM kirim', async t => {
  const c = await runJobCase(t, {
    options: { maxSizeBytes: 100 },
    info: { fileName: 'video.mp4', size: null, mimetype: 'video/mp4', downloadUrl: 'https://x/v.mp4', duration: 100, quality: 720 },
    downloadSize: 200,
  })
  await assert.rejects(c.run(), /melebihi batas/)
  assert.equal(c.downloads, 1, 'unduh jalan karena ukuran belum diketahui di getInfo')
  assert.equal(c.files.length, 0, 'tidak dikirim')
  const providerDir = path.join(c.root, 'src', 'downloads', 'youtube')
  const left = await fs.readdir(providerDir).catch(() => [])
  assert.deepEqual(left, [], 'folder job dihapus sesudah tolak')
})

test('runJob gerbang dokumen: resolusi/durasi/ukuran/flag -d -> dokumen, selebihnya inline', async t => {
  const baseInfo = { fileName: 'video.mp4', size: 5, mimetype: 'video/mp4', downloadUrl: 'https://x/v.mp4', duration: 200, quality: 720 }
  // Tanpa gerbang -> inline.
  const c0 = await runJobCase(t, { options: {}, info: baseInfo })
  await c0.run()
  assert.equal(c0.files.length, 1)
  assert.equal(c0.files[0].options?.asDocument, undefined, 'tanpa gerbang: video YouTube inline')
  // Resolusi 720p -> dokumen.
  const c1 = await runJobCase(t, { options: { docIfResolutionAtLeast: 720 }, info: baseInfo })
  await c1.run()
  assert.equal(c1.files[0].options?.asDocument, true, 'resolusi >= 720p -> dokumen')
  // Resolusi 480p di bawah ambang -> inline.
  const c2 = await runJobCase(t, { options: { docIfResolutionAtLeast: 720 }, info: { ...baseInfo, quality: 480 } })
  await c2.run()
  assert.equal(c2.files[0].options?.asDocument, undefined, 'resolusi 480p < 720 -> inline')
  // Durasi 700 dtk > 600 -> dokumen.
  const c3 = await runJobCase(t, { options: { docAboveDurationSec: 600 }, info: { ...baseInfo, duration: 700 } })
  await c3.run()
  assert.equal(c3.files[0].options?.asDocument, true, 'durasi > 10 menit -> dokumen')
  // Ukuran 200 byte > ambang 100 -> dokumen.
  const c4 = await runJobCase(t, { options: { docAboveBytes: 100 }, info: baseInfo, downloadSize: 200 })
  await c4.run()
  assert.equal(c4.files[0].options?.asDocument, true, 'ukuran > ambang -> dokumen')
  // Flag -d -> dokumen apa pun kondisinya.
  const c5 = await runJobCase(t, { options: { forceDocument: true }, info: { ...baseInfo, quality: 360, duration: 60 } })
  await c5.run()
  assert.equal(c5.files[0].options?.asDocument, true, 'flag -d -> dokumen')
})

test('runJob: fallback resolusi diberitahukan di pesan info', async t => {
  const c = await runJobCase(t, {
    options: {},
    info: { fileName: 'video.mp4', size: 5, mimetype: 'video/mp4', downloadUrl: 'https://x/v.mp4', duration: 200, quality: 720, requestedQuality: 1080, fallback: true },
  })
  await c.run()
  assert.equal(c.files.length, 1)
  assert.ok(c.sent.some(s => /1080p tidak tersedia/.test(s) && /memakai 720p/.test(s)), 'pesan info menyebut fallback 1080p -> 720p')
})

test('runJob formatDurationSec: detik/menit/jam', () => {
  assert.equal(formatDurationSec(45), '45 detik')
  assert.equal(formatDurationSec(600), '10 menit')
  assert.equal(formatDurationSec(125), '2 menit 5 detik')
  assert.equal(formatDurationSec(3600), '1 jam')
  assert.equal(formatDurationSec(3660), '1 jam 1 menit')
})
