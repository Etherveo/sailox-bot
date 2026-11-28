// tests/soloDownloaderPlugins.test.js — permukaan solo .ig / .fb (port yue,
// permintaan Veo 2026-11-27): handler + follow-up HD .fb, pakai engine
// .dl yang sama, tanpa jaringan nyata.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import igHandler from '../plugins/downloader/instagram.js'
import fbHandler, { createFbFollowupStore, pickHdAlternate, FB_FOLLOWUP_TTL_MS } from '../plugins/downloader/facebook.js'

function dgToken(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `https://cdn.downloadgram.org/?token=aaa.${b64}.bbb`
}

const VIDEO_BYTES = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])

function fakeConn(sentFiles, sentMessages = []) {
  return {
    sendFile: async (chat, src, name, caption, quoted, ptt, options) => { sentFiles.push({ chat, src, name, caption, options }) },
    sendMessage: async (chat, content) => { sentMessages.push({ chat, content }); return {} },
  }
}

function fakeQueue(finished = []) {
  return {
    enqueue: async () => ({ job: { id: 21 } }),
    finish: async (id, patch) => { finished.push(patch.status) },
  }
}

function fakeMsg(conn, overrides = {}) {
  return {
    chat: 'chat-solo', sender: 'S-solo', pushName: 'V',
    key: { remoteJid: 'chat-solo', id: 'msg1' },
    conn, fromMe: false,
    reply: async text => { replies.push(text); return { key: { id: 'prompt1' } } },
    ...overrides,
  }
}

// `reply` di atas butuh wadah replies per tes — dibuat ulang tiap pemakaian.
let replies = []

// ─── .ig ───────────────────────────────────────────────────────────────────

test('plugin .ig: satu reel dikirim inline dari file lokal, tmp dibersihkan', async () => {
  replies = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async url => {
    if (String(url).includes('instatiktok.com/api')) return Response.json({ status: 'success', html: '<a class="btn" href="https://cdn.test/reel.mp4">1</a>' })
    if (String(url).includes('cdn.test/')) return new Response(VIDEO_BYTES, { headers: { 'content-type': 'video/mp4' } })
    throw new Error('URL tak dikenal di stub: ' + url)
  }
  try {
    const sentFiles = []
    const conn = fakeConn(sentFiles)
    const finished = []
    const m = fakeMsg(conn)
    await igHandler(m, { conn, text: 'https://www.instagram.com/reel/XYZ/', downloadQueue: fakeQueue(finished) })
    assert.equal(sentFiles.length, 1)
    assert.ok(!String(sentFiles[0].src).startsWith('http'), 'src harus file lokal, bukan URL resolver')
    assert.ok(String(sentFiles[0].src).endsWith('.mp4'), 'src lokal harus .mp4')
    assert.equal(sentFiles[0].name, 'instagram-1.mp4')
    assert.deepEqual(sentFiles[0].options, {}, 'video IG inline, tanpa asDocument')
    assert.ok(sentFiles[0].caption.includes('Instagram'))
    await assert.rejects(fs.access(sentFiles[0].src), 'folder tmp .ig harus dibersihkan setelah kirim')
    assert.deepEqual(finished, ['done'])
  } finally { globalThis.fetch = realFetch }
})

test('plugin .ig: carousel 2 media dikirim berurutan, caption hanya di pertama', async () => {
  replies = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async url => {
    if (String(url).includes('instatiktok.com/api')) return Response.json({ status: 'success', html: '<a class="btn" href="https://cdn.test/a.mp4">1</a><a class="btn" href="https://cdn.test/b.jpg">2</a>' })
    if (String(url).includes('cdn.test/a.mp4')) return new Response(VIDEO_BYTES, { headers: { 'content-type': 'video/mp4' } })
    if (String(url).includes('cdn.test/b.jpg')) return new Response(VIDEO_BYTES, { headers: { 'content-type': 'image/jpeg' } })
    throw new Error('URL tak dikenal di stub: ' + url)
  }
  try {
    const sentFiles = []
    const conn = fakeConn(sentFiles)
    const m = fakeMsg(conn)
    await igHandler(m, { conn, text: 'https://www.instagram.com/p/ABC/', downloadQueue: fakeQueue() })
    assert.equal(sentFiles.length, 2)
    assert.equal(sentFiles[0].name, 'instagram-1.mp4')
    assert.equal(sentFiles[1].name, 'instagram-2.jpg')
    assert.ok(sentFiles[0].caption.includes('Instagram'))
    assert.equal(sentFiles[1].caption, '', 'caption hanya di media pertama')
  } finally { globalThis.fetch = realFetch }
})

test('plugin .ig: instatiktok gagal -> jatuh ke downloadgram (port yue)', async () => {
  replies = []
  const realFetch = globalThis.fetch
  const dgHtml = `<a href="${dgToken({ force: true, url: 'https://cdn.test/a.mp4' })}">1</a>`
  globalThis.fetch = async url => {
    if (String(url).includes('instatiktok.com/api')) return Response.json({ status: 'failed', html: '' })
    if (String(url).includes('api.downloadgram.org/media')) return new Response(dgHtml)
    if (String(url).includes('cdn.downloadgram.org/')) return new Response(VIDEO_BYTES, { headers: { 'content-type': 'video/mp4' } })
    throw new Error('URL tak dikenal di stub: ' + url)
  }
  try {
    const sentFiles = []
    const conn = fakeConn(sentFiles)
    const m = fakeMsg(conn)
    await igHandler(m, { conn, text: 'https://www.instagram.com/reel/XYZ/', downloadQueue: fakeQueue() })
    assert.equal(sentFiles.length, 1)
    assert.equal(sentFiles[0].name, 'instagram-1.mp4')
  } finally { globalThis.fetch = realFetch }
})

test('plugin .ig: URL bukan instagram -> pesan pemakaian', async () => {
  replies = []
  const conn = fakeConn([])
  const m = fakeMsg(conn)
  await assert.rejects(
    igHandler(m, { conn, text: 'https://example.com/x', downloadQueue: fakeQueue() }),
    /\.ig <link instagram>/,
  )
  await assert.rejects(
    igHandler(m, { conn, text: '', downloadQueue: fakeQueue() }),
    /\.ig <link instagram>/,
  )
})

// ─── .fb ───────────────────────────────────────────────────────────────────

const FB_TABLE_HD = `<div class="detail"><h3>Judul Tes</h3></div><table class="table"><tbody>
<tr><td class="video-quality">360p</td><td><a class="download-link-fb" href="https://cdn.test/360.mp4">unduh</a></td></tr>
<tr><td class="video-quality">720p (HD)</td><td><a class="download-link-fb" href="https://cdn.test/720.mp4">unduh</a></td></tr>
<tr><td class="video-quality">1080p</td><td><a class="download-link-fb" href="https://cdn.test/1080.mp4">unduh</a></td></tr>
</tbody></table>`

const FB_TABLE_SD_ONLY = `<table class="table"><tbody>
<tr><td class="video-quality">360p</td><td><a class="download-link-fb" href="https://cdn.test/360.mp4">unduh</a></td></tr>
</tbody></table>`

function fbFetch(table) {
  return async (url, opts = {}) => {
    if (String(url).includes('fbdownloader.to/api/ajaxSearch')) return Response.json({ status: 'ok', data: table })
    if (opts.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': '555', 'content-type': 'video/mp4' } })
    if (String(url).includes('cdn.test/')) return new Response(VIDEO_BYTES, { headers: { 'content-type': 'video/mp4' } })
    throw new Error('URL tak dikenal di stub: ' + url)
  }
}

test('pickHdAlternate: baris tertinggi di atas yang terkirim; tanpa itu null', () => {
  assert.equal(pickHdAlternate({ quality: '720p (HD)', alternates: [{ quality: '360p', downloadUrl: 'https://cdn/360.mp4' }, { quality: '1080p', downloadUrl: 'https://cdn/1080.mp4' }] }).downloadUrl, 'https://cdn/1080.mp4')
  assert.equal(pickHdAlternate({ quality: '1080p', alternates: [{ quality: '720p', downloadUrl: 'https://cdn/720.mp4' }] }), null, 'sudah kualitas tertinggi')
  assert.equal(pickHdAlternate({ quality: '360p', alternates: [{ quality: '720p', downloadUrl: 'https://cdn/720.mp4' }] }).downloadUrl, 'https://cdn/720.mp4')
  assert.equal(pickHdAlternate({ quality: '360p', alternates: [] }), null)
  assert.equal(pickHdAlternate({ quality: '360p' }), null, 'tanpa alternates')
  assert.equal(pickHdAlternate({ quality: 'SD', alternates: [{ quality: 'HD', downloadUrl: 'https://cdn/hd.mp4' }] }).downloadUrl, 'https://cdn/hd.mp4', 'label HD tanpa angka')
  assert.equal(pickHdAlternate({ quality: 'HD', alternates: [{ quality: 'SD', downloadUrl: 'https://cdn/sd.mp4' }] }), null)
})

test('plugin .fb: kirim 720p, tawar HD, balas hd kirim 1080p lalu entri habis', async () => {
  replies = []
  const realFetch = globalThis.fetch
  globalThis.fetch = fbFetch(FB_TABLE_HD)
  try {
    const sentFiles = []
    const sentMessages = []
    const conn = fakeConn(sentFiles, sentMessages)
    const finished = []
    const store = createFbFollowupStore()
    const m = fakeMsg(conn)
    await fbHandler(m, { conn, text: 'https://www.facebook.com/watch?v=123456', downloadQueue: fakeQueue(finished), fbFollowup: store })
    assert.equal(sentFiles.length, 1)
    assert.ok(!String(sentFiles[0].src).startsWith('http'), 'src harus file lokal, bukan URL resolver')
    assert.equal(sentFiles[0].name, 'facebook-123456.mp4')
    assert.deepEqual(sentFiles[0].options, {}, 'video FB inline, tanpa asDocument')
    assert.ok(sentFiles[0].caption.includes('720p'), 'caption membawa kualitas terkirim')
    assert.ok(replies.some(r => r.includes('hd') && r.includes('1080p')), 'prompt tawaran HD terkirim')
    assert.ok(!replies.some(r => /balas/i.test(r)), 'prompt TIDAK boleh menyuruh reply — reply ke pesan bot memicu trigger Ryn; cukup kirim teks biasa')
    assert.deepEqual(finished, ['done'])
    await assert.rejects(fs.access(sentFiles[0].src), 'folder tmp .fb harus dibersihkan setelah kirim')
    // Balas 'hd' -> kirim HD, prompt dihapus, entri terhapus; 'hd' kedua -> diam.
    const m2 = fakeMsg(conn, { text: 'hd', key: { remoteJid: 'chat-solo', id: 'msg2' } })
    assert.equal(await fbHandler.before(m2, { conn, fbFollowup: store }), true)
    assert.equal(sentFiles.length, 2)
    assert.equal(sentFiles[1].name, 'facebook_hd.mp4')
    assert.ok(sentFiles[1].caption.includes('1080p'))
    assert.ok(sentMessages.some(s => s.content?.delete?.id === 'prompt1'), 'pesan prompt dihapus setelah dipakai')
    assert.equal(await fbHandler.before(m2, { conn, fbFollowup: store }), false)
    assert.equal(sentFiles.length, 2, 'entri sudah dihapus setelah dipakai')
  } finally { globalThis.fetch = realFetch }
})

test('plugin .fb: tanpa baris HD -> tanpa tawaran, hd tidak bereaksi', async () => {
  replies = []
  const realFetch = globalThis.fetch
  globalThis.fetch = fbFetch(FB_TABLE_SD_ONLY)
  try {
    const sentFiles = []
    const conn = fakeConn(sentFiles)
    const store = createFbFollowupStore()
    const m = fakeMsg(conn)
    await fbHandler(m, { conn, text: 'https://www.facebook.com/watch?v=123456', downloadQueue: fakeQueue(), fbFollowup: store })
    assert.equal(sentFiles.length, 1)
    assert.equal(sentFiles[0].name, 'facebook-123456.mp4')
    assert.equal(replies.length, 0, 'tidak ada tawaran HD bila hanya ada satu kualitas')
    const m2 = fakeMsg(conn, { text: 'hd', key: { remoteJid: 'chat-solo', id: 'msg2' } })
    assert.equal(await fbHandler.before(m2, { conn, fbFollowup: store }), false)
  } finally { globalThis.fetch = realFetch }
})

test('plugin .fb: URL bukan facebook -> pesan pemakaian', async () => {
  replies = []
  const conn = fakeConn([])
  const m = fakeMsg(conn)
  await assert.rejects(
    fbHandler(m, { conn, text: 'https://example.com/x', downloadQueue: fakeQueue() }),
    /\.fb <link facebook>/,
  )
})

test('followup .fb: simpan, ambil, hapus, dan kedaluwarsa 60 detik', () => {
  let now = 1000
  const store = createFbFollowupStore({ now: () => now })
  store.put('chat1', 'S', { hdUrl: 'https://cdn/hd.mp4', quality: '1080p' })
  assert.equal(store.get('chat1', 'S').hdUrl, 'https://cdn/hd.mp4')
  assert.equal(store.get('chat2', 'S'), null, 'chat lain tidak ikut terpicu')
  now += 59 * 1000
  assert.ok(store.get('chat1', 'S'), 'masih hidup sebelum 60 detik')
  now += 1000
  assert.equal(store.get('chat1', 'S'), null, 'kedaluwarsa setelah 60 detik')
  assert.equal(FB_FOLLOWUP_TTL_MS, 60 * 1000)
})
