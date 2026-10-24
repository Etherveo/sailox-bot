import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createEngineRegistry } from '../lib/downloader/registry.js'
import { createEngineGuardian, engineGuardian, ownerJid } from '../lib/downloader/guardian.js'
import { runDownloadJob } from '../lib/downloader/runJob.js'
import { parseInstaTiktokLinks } from '../lib/downloader/instatiktok.js'
import * as tiktok from '../lib/downloader/engines/tiktok.js'
import * as facebook from '../lib/downloader/engines/facebook.js'
import * as instagram from '../lib/downloader/engines/instagram.js'
import * as pinterest from '../lib/downloader/engines/pinterest.js'
import * as twitter from '../lib/downloader/engines/twitter.js'

// ─── Resolver bersama instatiktok (TikTok / Facebook / Instagram) ────────────

function instaFetch(html, { headSize = '555' } = {}) {
  return async (url, opts = {}) => {
    const u = String(url)
    if (u.includes('instatiktok.com/api')) return Response.json({ status: 'success', html })
    if (opts.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': headSize, 'content-type': 'video/mp4' } })
    return new Response('media-bytes', { status: 200, headers: { 'content-type': 'video/mp4' } })
  }
}

test('instatiktok: tautan btn diekstrak unik berurutan, yang bukan btn diabaikan', () => {
  const html = `<a class="btn btn-primary" href="https://cdn/a.mp4">1</a>
  <a href="https://bukan/tombol.mp4">x</a>
  <a class="btn" href="https://cdn/a.mp4">duplikat</a>
  <a class="btn-download" href="https://cdn/b.mp4">kelas btn-download: pada situs nyata ini tombol juga (substring cheerio [class*=btn] tidak membedakan) — ikut terambil; yang disaring hanya jangkar TANPA 'btn' sama sekali</a>
  <a class="btn" href="https://cdn/c.mp4">3</a>`
  assert.deepEqual(parseInstaTiktokLinks(html), ['https://cdn/a.mp4', 'https://cdn/b.mp4', 'https://cdn/c.mp4'])
  const tanpaBtn = `<a href="https://bukan/tombol.mp4">x</a><a class="btn" href="https://cdn/a.mp4">1</a>`
  assert.deepEqual(parseInstaTiktokLinks(tanpaBtn), ['https://cdn/a.mp4'])
})

test('tiktok: adaptasi legacy downloader-tiktok.js — savetik dulu, tikwm fallback, SD dulu, foto jadi list, TANPA HEAD', async () => {
  assert.equal(tiktok.match('https://vt.tiktok.com/abc/'), true)
  assert.equal(tiktok.match('https://tiktok.com.evil.test/@u/video/1'), false)
  // Stub fetch yang mencatat method: getInfo TIDAK BOLEH melakukan HEAD
  // (HEAD dari VM terbukti 503/timeout pada URL yang hidup — itu yang
  // membunuh probe 0/5; legacy tidak pernah HEAD media).
  const methods = []
  const savetikHtml = '<h3>Judul Tes</h3><div class="dl-action">' +
    '<a href="https://cdn.test/hd.mp4">Download MP4 HD</a>' +
    '<a href="https://cdn.test/sd2.mp4">Download MP4 [2]</a>' +
    '<a href="https://cdn.test/sd1.mp4">Download MP4 [1]</a></div>'
  const fetchFn = async (url, opts = {}) => {
    methods.push(opts.method || 'GET')
    const u = String(url)
    if (u.includes('savetik.io/api')) return Response.json({ status: 'ok', data: savetikHtml })
    if (u.includes('tikwm.com/api')) return Response.json({ code: 0, data: { title: 'T', play: 'https://cdn.test/play.mp4', hdplay: 'https://cdn.test/hdplay.mp4' } })
    throw new Error('URL tak dikenal di stub: ' + u)
  }
  // Savetik sukses: video utama = SD [1], bukan HD.
  const info = await tiktok.getInfo('https://vt.tiktok.com/abc/', { fetchFn })
  assert.equal(info.downloadUrl, 'https://cdn.test/sd1.mp4')
  assert.equal(info.fileName, 'tiktok.mp4')
  assert.ok(!methods.includes('HEAD'), 'getInfo tidak boleh HEAD: ' + methods.join(','))
  // Savetik gagal -> fallback tikwm (play/SD).
  const fbFetch = async (url, opts = {}) => {
    methods.push(opts.method || 'GET')
    if (String(url).includes('savetik.io/api')) return Response.json({ status: 'fail', data: '' })
    if (String(url).includes('tikwm.com/api')) return Response.json({ code: 0, data: { title: 'T', play: 'https://cdn.test/play.mp4', hdplay: 'https://cdn.test/hdplay.mp4' } })
    throw new Error('URL tak dikenal di stub')
  }
  const fb = await tiktok.getInfo('https://vt.tiktok.com/abc/', { fetchFn: fbFetch })
  assert.equal(fb.downloadUrl, 'https://cdn.test/play.mp4')
  // Foto >1 -> list bermediaItems (album); foto didahulukan atas video.
  const photoHtml = '<h3>Foto</h3><div class="photo-list">' +
    '<div class="download-items"><a href="https://cdn.test/f1.jpg">1</a></div>' +
    '<div class="download-items"><a href="https://cdn.test/f2.jpg">2</a></div></div>' +
    '<div class="dl-action"><a href="https://cdn.test/v.mp4">Download MP4 [1]</a></div>'
  const photoFetch = async (url) => {
    if (String(url).includes('savetik.io/api')) return Response.json({ status: 'ok', data: photoHtml })
    throw new Error('tikwm tidak boleh dipanggil bila savetik sudah memberi foto')
  }
  const list = await tiktok.getInfo('https://vt.tiktok.com/abc/', { fetchFn: photoFetch })
  assert.equal(list.isList, true)
  assert.equal(list.mediaItems.length, 2)
  assert.equal(list.mediaItems[0].downloadUrl, 'https://cdn.test/f1.jpg')
  // Kedua resolver gagal total -> error, bukan sukses kosong.
  const deadFetch = async () => Response.json({ status: 'fail', data: '' })
  await assert.rejects(() => tiktok.getInfo('https://vt.tiktok.com/abc/', { fetchFn: deadFetch }))
})

test('facebook: tautan TERAKHIR dari resolver dipilih (aturan legacy)', async () => {
  const html = `<a class="btn" href="https://cdn/360.mp4">360</a><a class="btn" href="https://cdn/720.mp4">720</a><a class="btn" href="https://cdn/hd-final.mp4">HD</a>`
  const info = await facebook.getInfo('https://www.facebook.com/watch?v=123456', { fetchFn: instaFetch(html) })
  assert.equal(info.downloadUrl, 'https://cdn/hd-final.mp4')
  assert.equal(info.fileName, 'facebook-123456.mp4')
  assert.equal(facebook.match('https://fb.watch/abc/'), true)
  assert.equal(facebook.match('https://facebook.com.evil.test/x'), false)
})

test('instagram: semua tautan jadi list, #item memilih satu', async () => {
  // Tautan asli instatiktok berbentuk force-download.php?url=<base64> —
  // nama berkas tidak terbaca darinya, jadi nama generik per indeks.
  const html = `<a class="btn" href="https://instatiktok.com/force-download.php?url=AAA">1</a><a class="btn" href="https://instatiktok.com/force-download.php?url=BBB">2</a>`
  const fetchFn = instaFetch(html)
  const list = await instagram.getInfo('https://www.instagram.com/p/ABC/', { fetchFn })
  assert.equal(list.isList, true)
  assert.equal(list.files[0].fileName, 'instagram-1')
  assert.equal(list.mediaItems.length, 2, 'list multi-media membawa mediaItems untuk dikirim semua')
  assert.equal(list.mediaItems[1].downloadUrl, 'https://instatiktok.com/force-download.php?url=BBB')
  const picked = await instagram.getInfo('https://www.instagram.com/p/ABC/#item=2', { fetchFn })
  assert.equal(picked.fileName, 'instagram-2')
  assert.equal(picked.mimetype, null)
  assert.equal(picked.downloadUrl, 'https://instatiktok.com/force-download.php?url=BBB')
  const single = await instagram.getInfo('https://www.instagram.com/reel/XYZ/', { fetchFn: instaFetch('<a class="btn" href="https://cdn/satu.mp4">1</a>') })
  assert.equal(single.downloadUrl, 'https://cdn/satu.mp4')
  assert.equal(instagram.match('https://www.instagram.com/reel/XYZ/'), true)
})

// ─── Pinterest ───────────────────────────────────────────────────────────────

test('pinterest: token steptodown + video didahulukan dari gambar', async () => {
  assert.equal(pinterest.extractStepToken('<input name="token" value="tok123">'), 'tok123')
  const data = { title: 'Pin Keren', medias: [
    { url: 'https://pin/img.jpg', extension: 'jpg', formattedSize: '200 KB' },
    { url: 'https://pin/vid.mp4', extension: 'mp4', formattedSize: '5 MB' },
  ] }
  assert.equal(pinterest.pickMedia(data.medias).url, 'https://pin/vid.mp4')
  assert.equal(pinterest.pickMedia([data.medias[0]]).url, 'https://pin/img.jpg')
  const fetchFn = async url => String(url).includes('video-data')
    ? Response.json(data)
    : new Response('<input name="token" value="tok123">')
  const info = await pinterest.getInfo('https://id.pinterest.com/pin/123/', { fetchFn })
  assert.equal(info.downloadUrl, 'https://pin/vid.mp4')
  assert.equal(info.size, 5 * 1024 * 1024)
  assert.equal(info.fileName, 'Pin Keren.mp4')
  assert.equal(pinterest.match('https://pin.it/abcde'), true)
  assert.equal(pinterest.match('https://pinterest.com.evil.test/pin/1'), false)
})

// ─── Twitter ─────────────────────────────────────────────────────────────────

test('twitter: vxtwitter multi-media jadi list, ponta jadi cadangan', async () => {
  const vx = { text: 'halo', user_name: 'Tes', media_extended: [
    { type: 'video', url: 'https://video.twimg.com/v.mp4' },
    { type: 'image', url: 'https://pbs.twimg.com/i.jpg' },
  ] }
  assert.equal(twitter.parseVxTwitter(vx).items.length, 2)
  const fetchVx = async () => Response.json(vx)
  const list = await twitter.getInfo('https://x.com/user/status/123456', { fetchFn: fetchVx })
  assert.equal(list.isList, true)
  const picked = await twitter.getInfo('https://x.com/user/status/123456#item=1', { fetchFn: fetchVx })
  assert.equal(picked.fileName, 'twitter-123456-1.mp4')

  const fetchPonta = async url => String(url).includes('vxtwitter')
    ? new Response('err', { status: 500 })
    : Response.json({ status: 'success', text: 't', author: { name: 'A' }, media: [{ type: 'photo', url: 'https://pbs/p.jpg' }] })
  const info = await twitter.getInfo('https://twitter.com/user/status/999', { fetchFn: fetchPonta })
  assert.equal(info.downloadUrl, 'https://pbs/p.jpg')
  assert.equal(twitter.match('https://x.com/user/status/123'), true)
  assert.equal(twitter.match('https://x.com/home'), false)
})

// ─── Penjaga (guardian) ──────────────────────────────────────────────────────

test('guardian: dedupe per engine+fase dengan cooldown, laporan tertahan dihitung', async () => {
  let nowVal = 1_000_000
  const sent = []
  const g = createEngineGuardian({ notify: async teks => { sent.push(teks) }, now: () => nowVal, cooldownMs: 30 * 60 * 1000 })
  await g.report({ engineId: 'tiktok', phase: 'getInfo', error: new Error('tikwm mati'), url: 'https://tiktok.com/x' })
  await g.report({ engineId: 'tiktok', phase: 'getInfo', error: new Error('tikwm mati') })
  const third = await g.report({ engineId: 'tiktok', phase: 'getInfo', error: new Error('tikwm mati') })
  assert.equal(sent.length, 1)
  assert.equal(third.sent, false)
  assert.equal(third.suppressed, 2)
  assert.match(sent[0], /Engine: tiktok/)
  await g.report({ engineId: 'tiktok', phase: 'download', error: new Error('cdn putus') })
  assert.equal(sent.length, 2, 'fase berbeda tetap dilaporkan')
  nowVal += 31 * 60 * 1000
  await g.report({ engineId: 'tiktok', phase: 'getInfo', error: new Error('tikwm mati lagi') })
  assert.equal(sent.length, 3, 'setelah cooldown laporan jalan lagi')
  assert.match(sent[2], /2 error serupa tertahan/)
})

test('guardian: laporan sebelum notifier terpasang ditahan lalu diteruskan', async () => {
  const g = createEngineGuardian({ now: () => 5000 })
  const r = await g.report({ engineId: 'mega', phase: 'load', error: new Error('syntax rusak') })
  assert.equal(r.queued, true)
  const sent = []
  g.setNotifier(async teks => { sent.push(teks) })
  await new Promise(res => setTimeout(res, 20))
  assert.equal(sent.length, 1)
  assert.match(sent[0], /Fase: load/)
})

test('guardian: ownerJid dari global founder', () => {
  const prevFounder = globalThis.founder
  const prevOwner = globalThis.owner
  try {
    globalThis.founder = [['6282348181097', '', 'Veo']]
    globalThis.owner = []
    assert.equal(ownerJid(), '6282348181097@s.whatsapp.net')
  } finally {
    globalThis.founder = prevFounder
    globalThis.owner = prevOwner
  }
})

test('runJob: kegagalan engine dilaporkan penjaga ke owner', async () => {
  const sent = []
  engineGuardian.setNotifier(async teks => { sent.push(teks) })
  try {
    const registry = { getEngine: () => ({ async getInfo() { throw new Error('resolver guardtest meledak') }, async download() { throw new Error('tidak sampai') } }) }
    const conn = { sendMessage: async () => {}, sendFile: async () => {} }
    await assert.rejects(
      runDownloadJob({ conn, job: { id: 99, url: 'https://x', provider: 'guardtest', chat: 'c', sender: 'A' }, registry, rootDir: process.cwd() }),
      /resolver guardtest meledak/
    )
    assert.equal(sent.length, 1)
    assert.match(sent[0], /Engine: guardtest/)
    assert.match(sent[0], /Fase: getInfo/)
  } finally {
    engineGuardian.setNotifier(null)
  }
})

test('engine sosial terdaftar di registry nyata', async () => {
  const registry = createEngineRegistry({ dir: path.join(process.cwd(), 'lib/downloader/engines') })
  await registry.loadAll()
  for (const idE of ['tiktok', 'facebook', 'instagram', 'pinterest', 'twitter']) assert.ok(registry.has(idE), `engine ${idE} aktif`)
  assert.equal(registry.detectProvider('https://www.tiktok.com/@u/video/1'), 'tiktok')
  assert.equal(registry.detectProvider('https://www.facebook.com/watch?v=1'), 'facebook')
  assert.equal(registry.detectProvider('https://www.instagram.com/p/ABC/'), 'instagram')
  assert.equal(registry.detectProvider('https://id.pinterest.com/pin/1/'), 'pinterest')
  assert.equal(registry.detectProvider('https://x.com/u/status/123'), 'twitter')
})
