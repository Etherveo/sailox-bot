import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import * as youtube from '../lib/downloader/engines/youtube.js'
import { inspectEngine } from '../lib/downloader/registry.js'
import { createDownloadQueue } from '../lib/downloader/queue.js'
import { fakeConn } from './fixtures.js'
import playHandler from '../plugins/downloader/play.js'

// Kunci protokol savetube — SAMA seperti di engine (diuji di sini supaya
// perubahan kunci di engine langsung ketahuan tes ini).
const SAVETUBE_KEY = 'C5D58EF67A7584E4A29F6C35BBC4EB12'

function encryptSavetubePayload(obj) {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(SAVETUBE_KEY, 'hex'), iv)
  return Buffer.concat([iv, cipher.update(JSON.stringify(obj)), cipher.final()]).toString('base64')
}

const VIDEO_ID = 'dQw4w9WgXcQ'
const WATCH = `https://www.youtube.com/watch?v=${VIDEO_ID}`
const SHORT = `https://youtu.be/${VIDEO_ID}`

// ─── match & extractVideoId ──────────────────────────────────────────────────

test('youtube match: varian link video diterima, domain peniru & non-video ditolak', () => {
  assert.equal(youtube.match(WATCH), true)
  assert.equal(youtube.match(SHORT), true)
  assert.equal(youtube.match(`https://www.youtube.com/shorts/${VIDEO_ID}`), true)
  assert.equal(youtube.match(`https://www.youtube.com/embed/${VIDEO_ID}`), true)
  assert.equal(youtube.match(`https://music.youtube.com/watch?v=${VIDEO_ID}`), true)
  assert.equal(youtube.match(`https://www.youtube.com/watch?v=${VIDEO_ID}&list=PLx&index=2`), true)
  assert.equal(youtube.match('https://www.youtube.com/playlist?list=PL12345678901'), false)
  assert.equal(youtube.match('https://www.youtube.com/@SomeChannel'), false)
  assert.equal(youtube.match('https://www.youtube.com/'), false)
  assert.equal(youtube.match('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ'), false)
  assert.equal(youtube.match('https://evil.test/?u=youtube.com/watch?v=dQw4w9WgXcQ'), false)
  assert.equal(youtube.match('https://pixeldrain.com/u/abc'), false)
  assert.equal(youtube.match('bukan url'), false)
})

test('youtube extractVideoId: semua bentuk link video', () => {
  assert.equal(youtube.extractVideoId(WATCH), VIDEO_ID)
  assert.equal(youtube.extractVideoId(SHORT), VIDEO_ID)
  assert.equal(youtube.extractVideoId(`https://youtu.be/${VIDEO_ID}?si=abc123`), VIDEO_ID)
  assert.equal(youtube.extractVideoId(`https://www.youtube.com/shorts/${VIDEO_ID}`), VIDEO_ID)
  assert.equal(youtube.extractVideoId(`https://www.youtube.com/embed/${VIDEO_ID}`), VIDEO_ID)
  assert.equal(youtube.extractVideoId(`https://music.youtube.com/watch?v=${VIDEO_ID}&si=x`), VIDEO_ID)
  assert.equal(youtube.extractVideoId('https://www.youtube.com/playlist?list=PL12345678901'), null)
  assert.equal(youtube.extractVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), null)
  assert.equal(youtube.extractVideoId(''), null)
})

// ─── decryptData ───────────────────────────────────────────────────────────

test('youtube decryptData: round-trip enkripsi savetube', () => {
  const payload = { title: 'Lagu Tes', duration: 200, key: 'kunci123' }
  assert.deepEqual(youtube.decryptData(encryptSavetubePayload(payload)), payload)
  assert.throws(() => youtube.decryptData('!!!bukan-base64!!!'), /tidak valid/)
  assert.throws(() => youtube.decryptData(Buffer.from('terlalu-pendek').toString('base64')), /tidak valid/)
})

// ─── parseSearchResults ────────────────────────────────────────────────────

const searchFixture = {
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: {
        sectionListRenderer: {
          contents: [
            { itemSectionRenderer: { contents: [
              { videoRenderer: {
                videoId: VIDEO_ID,
                title: { runs: [{ text: 'Rick Astley - Never Gonna Give You Up (Official Video)' }] },
                lengthText: { simpleText: '3:33' },
                viewCountText: { simpleText: '1.234.567 views' },
                publishedTimeText: { simpleText: '15 years ago' },
                ownerText: { runs: [{ text: 'Rick Astley' }] },
              } },
              { videoRenderer: {
                videoId: 'AAAAAAAAAAAAAAAAAAA',
                title: { runs: [{ text: 'Video Kedua' }] },
                lengthText: { simpleText: '1:00' },
              } },
            ] } },
          ],
        },
      },
    },
  },
}

test('youtube parseSearchResults: video pertama + field-nya', () => {
  const v = youtube.parseSearchResults(searchFixture)
  assert.equal(v.videoId, VIDEO_ID)
  assert.equal(v.title, 'Rick Astley - Never Gonna Give You Up (Official Video)')
  assert.equal(v.url, SHORT)
  assert.equal(v.seconds, 213)
  assert.equal(v.views, 1234567)
  assert.equal(v.ago, '15 years ago')
  assert.equal(v.author.name, 'Rick Astley')
  assert.equal(youtube.parseSearchResults({}), null)
  assert.equal(youtube.parseSearchResults({ contents: {} }), null)
})

// ─── searchYouTube (fetch palsu) ───────────────────────────────────────────

function searchFetch(json) {
  return async (url) => {
    if (String(url).includes('youtubei/v1/search')) {
      return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error('route tidak dikenal: ' + url)
  }
}

test('youtube searchYouTube: hasil pertama, tanpa hasil dilempar jelas', async () => {
  const v = await youtube.searchYouTube('rick astley', { fetchFn: searchFetch(searchFixture) })
  assert.equal(v.videoId, VIDEO_ID)
  await assert.rejects(
    youtube.searchYouTube('zzzz-tidak-ada', { fetchFn: searchFetch({}) }),
    /Tidak ada hasil video untuk: zzzz-tidak-ada/,
  )
  await assert.rejects(
    youtube.searchYouTube('   ', { fetchFn: searchFetch(searchFixture) }),
    /kata kunci/,
  )
})

// ─── getInfo + download (fetch palsu) ───────────────────────────────────────

function savetubeFetch({ infoPayload, downloadUrl = 'https://cdn999.savetube.vip/media/x.mp3', infoStatus = 200 } = {}) {
  return async (url) => {
    const u = String(url)
    if (u.includes('random-cdn')) {
      return new Response(JSON.stringify({ cdn: 'cdn999.savetube.vip' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.includes('/v2/info')) {
      return new Response(JSON.stringify({ data: encryptSavetubePayload(infoPayload) }), { status: infoStatus, headers: { 'content-type': 'application/json' } })
    }
    if (u.includes('/download')) {
      return new Response(JSON.stringify({ data: { downloadUrl } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error('route tidak dikenal: ' + u)
  }
}

const INFO_PAYLOAD = { title: 'Lagu Tes (Official Video)', duration: 200, key: 'kunci123' }

test('youtube getInfo: alur savetube penuh -> mp3 + metadata', async () => {
  const info = await youtube.getInfo(WATCH, { fetchFn: savetubeFetch({ infoPayload: INFO_PAYLOAD }) })
  assert.equal(info.fileName, 'Lagu Tes (Official Video).mp3')
  assert.equal(info.mimetype, 'audio/mpeg')
  assert.equal(info.size, null)
  assert.equal(info.downloadUrl, 'https://cdn999.savetube.vip/media/x.mp3')
  assert.equal(info.title, 'Lagu Tes (Official Video)')
  assert.equal(info.duration, 200)
  assert.equal(info.videoId, VIDEO_ID)
})

test('youtube getInfo: link bukan video & info savetube rusak ditolak', async () => {
  await assert.rejects(youtube.getInfo('https://www.youtube.com/', { fetchFn: savetubeFetch({ infoPayload: INFO_PAYLOAD }) }), /tidak valid/)
  await assert.rejects(
    youtube.getInfo(WATCH, { fetchFn: savetubeFetch({ infoPayload: INFO_PAYLOAD, infoStatus: 500 }) }),
    /Savetube merespons status 500/,
  )
})

test('youtube download: stream mp3 ke disk', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-yt-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  const fetchFn = async () => new Response(mp3, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
  const info = { fileName: 'Lagu Tes.mp3', downloadUrl: 'https://cdn999.savetube.vip/media/x.mp3', mimetype: 'audio/mpeg' }
  const result = await youtube.download(WATCH, info, { destDir: dir, baseName: 'lagu-tes', fetchFn })
  assert.equal(result.fileName, 'lagu-tes.mp3')
  assert.equal(result.mimetype, 'audio/mpeg')
  assert.equal(result.size, 10)
  assert.deepEqual(await fs.readFile(result.filePath), mp3)
  await assert.rejects(
    youtube.download(WATCH, { fileName: 'x.mp3' }, { destDir: dir, baseName: 'x', fetchFn }),
    /tidak membawa link unduhan/,
  )
})

// ─── kontrak registry ──────────────────────────────────────────────────────

test('youtube engine lolos kontrak registry (id == nama file)', async () => {
  const code = await fs.readFile(new URL('../lib/downloader/engines/youtube.js', import.meta.url), 'utf8')
  const { exports } = inspectEngine(code)
  for (const name of ['id', 'match', 'getInfo', 'download']) assert.ok(exports.includes(name), `ekspor ${name} wajib ada`)
  assert.equal(youtube.id, 'youtube')
})

// ─── plugin .play ──────────────────────────────────────────────────────────

function fakeM() {
  const replies = []
  return {
    chat: 'tes@s.whatsapp.net',
    sender: 'founder@s.whatsapp.net',
    key: { id: 'play1', remoteJid: 'tes@s.whatsapp.net', fromMe: false },
    replies,
    reply: async teks => { replies.push(String(teks)) },
  }
}

async function fakeQueue(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-play-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  global.pluginLoader = { root: path.join(root, 'plugins') }
  t.after(() => { delete global.pluginLoader })
  const queue = createDownloadQueue({ file: path.join(root, 'q.json'), processJob: async () => ({}) })
  return { root, queue }
}

async function drainQueue(queue) {
  for (let i = 0; i < 50; i++) {
    const snap = await queue.snapshot()
    if (!snap.jobs.length) break
    await new Promise(r => setTimeout(r, 20))
  }
}

test('play: tanpa teks dilempar usage, command/help/tags/limit', () => {
  assert.match('play', playHandler.command)
  assert.equal(playHandler.limit, 3)
  assert.deepEqual(playHandler.tags, ['downloader'])
  assert.ok(playHandler.help.some(h => h.startsWith('play ')))
})

test('play: tanpa teks -> usage; link invalid -> ditolak', async t => {
  const { queue } = await fakeQueue(t)
  const conn = fakeConn()
  await assert.rejects(playHandler(fakeM(), { conn, text: '', usedPrefix: '.', command: 'play', downloadQueue: queue }), /\.play <judul lagu/)
  await assert.rejects(
    playHandler(fakeM(), { conn, text: 'https://www.youtube.com/playlist?list=PL12345678901', usedPrefix: '.', command: 'play', downloadQueue: queue }),
    /tidak valid/,
  )
  await drainQueue(queue)
})

test('play: query -> balasan video ditemukan + masuk antrean YouTube', async t => {
  const { queue } = await fakeQueue(t)
  const conn = fakeConn()
  const m = fakeM()
  const found = youtube.parseSearchResults(searchFixture)
  await playHandler(m, { conn, text: 'rick astley', usedPrefix: '.', command: 'play', downloadQueue: queue, searchYouTube: async () => found })
  assert.match(m.replies[0], /Rick Astley - Never Gonna Give You Up/)
  assert.match(m.replies[0], /3:33/)
  assert.match(m.replies.at(-1), /Masuk antrean #1/)
  assert.match(m.replies.at(-1), /YouTube/)
  await drainQueue(queue)
})

test('play: link YouTube langsung -> masuk antrean', async t => {
  const { queue } = await fakeQueue(t)
  const conn = fakeConn()
  const m = fakeM()
  await playHandler(m, { conn, text: SHORT, usedPrefix: '.', command: 'play', downloadQueue: queue })
  assert.match(m.replies.at(-1), /Masuk antrean #1/)
  assert.match(m.replies.at(-1), /YouTube/)
  assert.match(m.replies.at(-1), new RegExp(VIDEO_ID))
  await drainQueue(queue)
})

test('play: pencarian tanpa hasil -> error jelas; antrean didelegasikan', async t => {
  const { queue } = await fakeQueue(t)
  const conn = fakeConn()
  await assert.rejects(
    playHandler(fakeM(), { conn, text: 'zzzz-tidak-ada', usedPrefix: '.', command: 'play', downloadQueue: queue, searchYouTube: async () => { throw new Error('Tidak ada hasil video untuk: zzzz-tidak-ada') } }),
    /Tidak ada hasil video/,
  )
  const m = fakeM()
  await playHandler(m, { conn, text: 'antrean', usedPrefix: '.', command: 'play', downloadQueue: queue })
  assert.match(m.replies.at(-1), /Antrean unduhan/)
  await drainQueue(queue)
})
