// tests/nekopoi.test.js — port fitur nekopoi (plugins/internet/nekopoi.js):
// search menghasilkan daftar bernomor + sesi handler.before (tanpa
// button), detail menampilkan info/stream/download, gerbang premium.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import nekopoiHandler, {
  createNekopoiSessionStore, parseSearchResults, parseDetail,
  formatSearchText, formatDetailText, isNekopoiUrl,
} from '../plugins/internet/nekopoi.js'

const SEARCH_HTML = `
<div class="nk-search-results"><ul>
  <li>
    <a href="https://nekopoi.care/judul-satu/"><h2>Judul Satu</h2></a>
    <div class="nk-search-thumb" style="background-image: url('https://nekopoi.care/img/satu.jpg')"></div>
    <div class="nk-search-genres">Action, Drama</div>
    <div class="nk-search-desc">Deskripsi satu.</div>
  </li>
  <li>
    <a href="https://nekopoi.care/judul-dua/"><h2>Judul Dua</h2></a>
    <div class="nk-search-thumb" style="background-image: url(https://nekopoi.care/img/dua.jpg)"></div>
    <div class="nk-search-genres">Comedy</div>
    <div class="nk-search-desc">Deskripsi dua.</div>
  </li>
</ul></div>`

const DETAIL_HTML = `
<h1>Judul Satu Episode 1</h1>
<meta property="og:image" content="https://nekopoi.care/img/satu.jpg">
<meta property="og:description" content="Deskripsi detail.">
<div class="konten">
  <p>Genre: Action, Drama</p>
  <p>Producers: Studio X</p>
  <p>Duration: 24 menit</p>
  <p>Size: 300MB</p>
</div>
<div id="nk-player">
  <div class="nk-player-frame" id="server1"><iframe src="https://stream.example/embed/1"></iframe></div>
</div>
<a class="nk-player-series" href="https://nekopoi.care/series/satu/"></a>
<div class="nk-player-series-title">Series Satu</div>
<div class="nk-download-row">
  <div class="nk-download-name">720p</div>
  <div class="nk-download-links">
    <a href="https://host.example/dl/720a">HostA</a>
    <a href="https://host.example/dl/720b">HostB</a>
  </div>
</div>
<div class="nk-download-row">
  <div class="nk-download-name">480p</div>
  <div class="nk-download-links"><a href="https://host.example/dl/480a">HostA</a></div>
</div>
<a class="nk-episode-prev" href="https://nekopoi.care/ep-sebelum/"><span>Episode 0</span></a>
<a class="nk-episode-next" href="https://nekopoi.care/ep-sesudah/"><span>Episode 2</span></a>`

test('isNekopoiUrl: hanya https di host nekopoi.care', () => {
  assert.equal(isNekopoiUrl('https://nekopoi.care/judul-satu/'), true)
  assert.equal(isNekopoiUrl('https://www.nekopoi.care/x'), true)
  assert.equal(isNekopoiUrl('http://nekopoi.care/x'), false)
  assert.equal(isNekopoiUrl('https://evil.example/x'), false)
  assert.equal(isNekopoiUrl('https://nekopoi.care.evil.example/x'), false)
  assert.equal(isNekopoiUrl('bukan url'), false)
  assert.equal(isNekopoiUrl(''), false)
})

test('parseSearchResults: memetakan hasil seperti legacy', () => {
  const results = parseSearchResults(SEARCH_HTML)
  assert.equal(results.length, 2)
  assert.equal(results[0].title, 'Judul Satu')
  assert.equal(results[0].link, 'https://nekopoi.care/judul-satu/')
  assert.equal(results[0].thumbnail, 'https://nekopoi.care/img/satu.jpg')
  assert.equal(results[0].genres, 'Action, Drama')
  assert.equal(results[1].thumbnail, 'https://nekopoi.care/img/dua.jpg')
  assert.deepEqual(parseSearchResults('<html></html>'), [])
})

test('parseDetail: info, stream, download per kualitas, series, navigasi', () => {
  const data = parseDetail(DETAIL_HTML)
  assert.equal(data.title, 'Judul Satu Episode 1')
  assert.equal(data.thumbnail, 'https://nekopoi.care/img/satu.jpg')
  assert.equal(data.info.genre, 'Action, Drama')
  assert.equal(data.info.producers, 'Studio X')
  assert.equal(data.streams.length, 1)
  assert.equal(data.streams[0].src, 'https://stream.example/embed/1')
  assert.equal(data.downloads.length, 2)
  assert.equal(data.downloads[0].quality, '720p')
  assert.equal(data.downloads[0].links.length, 2)
  assert.equal(data.series.url, 'https://nekopoi.care/series/satu/')
  assert.equal(data.nav.prev.url, 'https://nekopoi.care/ep-sebelum/')
  assert.equal(data.nav.next.title, 'Episode 2')
})

test('format tampilan: daftar bernomor + instruksi sesi; detail memuat link unduhan', () => {
  const results = parseSearchResults(SEARCH_HTML)
  const text = formatSearchText('satu', results)
  assert.match(text, /1\. \*Judul Satu\*/)
  assert.match(text, /2\. \*Judul Dua\*/)
  assert.match(text, /batal/)
  const detail = formatDetailText(parseDetail(DETAIL_HTML))
  assert.match(detail, /\*720p:\*/)
  assert.match(detail, /https:\/\/host\.example\/dl\/720a/)
  assert.match(detail, /Episode Selanjutnya/)
})

test('session store: put/get/touch/delete + kedaluwarsa malas', () => {
  let nowVal = 1000
  const store = createNekopoiSessionStore({ ttlMs: 1000, now: () => nowVal })
  store.put('c', 'A', { keyword: 'x', items: [1] })
  assert.equal(store.get('c', 'A')?.keyword, 'x')
  assert.equal(store.get('c', 'B'), null)
  nowVal = 1900
  store.touch('c', 'A')
  nowVal = 2500
  assert.ok(store.get('c', 'A'), 'touch memperpanjang TTL')
  nowVal = 3000
  assert.equal(store.get('c', 'A'), null, 'kedaluwarsa sesudah TTL terakhir')
  store.put('c', 'A', { keyword: 'y', items: [] })
  store.delete('c', 'A')
  assert.equal(store.get('c', 'A'), null)
})

function fakeMsg(over = {}) {
  const replies = []
  const m = {
    chat: '120363@g.us', sender: '628111@s.whatsapp.net', pushName: 'Premium User',
    text: '', fromMe: false, key: { remoteJid: '120363@g.us', id: 'm1' },
    reply: async t => { replies.push(String(t)) },
    ...over,
  }
  m.replies = replies
  return m
}

function fakeConn() {
  const sent = []
  return { sent, sendMessage: async (chat, content, opts) => { sent.push({ chat, content, opts }); return { key: { id: 's1' } } } }
}

function fakeFetch(routes) {
  return async url => {
    const html = routes[String(url)]
    if (html == null) return { ok: false, status: 404, text: async () => '' }
    return { ok: true, status: 200, text: async () => html }
  }
}

test('handler search: sesi dibuka + daftar bernomor dikirim; gerbang premium terpasang', async () => {
  assert.equal(nekopoiHandler.premium, true, 'premium only sesuai perintah Veo')
  const store = createNekopoiSessionStore()
  const m = fakeMsg()
  const ctx = {
    conn: fakeConn(), text: 'search satu', usedPrefix: '.', command: 'nekopoi',
    nekopoiSessions: store,
    nekopoiFetch: fakeFetch({ 'https://nekopoi.care/search/satu': SEARCH_HTML }),
  }
  await nekopoiHandler(m, ctx)
  assert.equal(store.get(m.chat, m.sender)?.items.length, 2)
  assert.match(m.replies[0], /Hasil pencarian: "satu"/)
  assert.match(m.replies[0], /1\. \*Judul Satu\*/)
})

test('handler search: tanpa hasil -> pesan tidak ditemukan, tanpa sesi', async () => {
  const store = createNekopoiSessionStore()
  const m = fakeMsg()
  const ctx = {
    conn: fakeConn(), text: 'search kosong', usedPrefix: '.', command: 'nekopoi',
    nekopoiSessions: store,
    nekopoiFetch: fakeFetch({ 'https://nekopoi.care/search/kosong': '<html></html>' }),
  }
  await nekopoiHandler(m, ctx)
  assert.equal(store.get(m.chat, m.sender), null)
  assert.match(m.replies[0], /Tidak ada hasil/)
})

test('handler detail: URL non-nekopoi ditolak; URL sah membuka detail', async () => {
  const m = fakeMsg()
  const base = { conn: fakeConn(), usedPrefix: '.', command: 'nekopoi', nekopoiFetch: fakeFetch({ 'https://nekopoi.care/judul-satu/': DETAIL_HTML }) }
  await assert.rejects(() => nekopoiHandler(m, { ...base, text: 'detail https://evil.example/x' }), /harus link nekopoi\.care/)
  const conn = fakeConn()
  await nekopoiHandler(fakeMsg(), { ...base, conn, text: 'detail https://nekopoi.care/judul-satu/' })
  assert.equal(conn.sent.length, 1)
  assert.equal(conn.sent[0].content.image.url, 'https://nekopoi.care/img/satu.jpg')
  assert.match(conn.sent[0].content.caption, /Judul Satu Episode 1/)
})

test('handler: subcommand tak dikenal / search tanpa kata kunci -> usage', async () => {
  const base = { conn: fakeConn(), usedPrefix: '.', command: 'nekopoi', nekopoiFetch: fakeFetch({}) }
  await assert.rejects(() => nekopoiHandler(fakeMsg(), { ...base, text: '' }), /Perintah tidak dikenali/)
  await assert.rejects(() => nekopoiHandler(fakeMsg(), { ...base, text: 'search' }), /Masukkan judulnya/)
})

test('before: angka membuka detail dari sesi; sesi tetap buka; batal menutup', async () => {
  const store = createNekopoiSessionStore()
  const results = parseSearchResults(SEARCH_HTML)
  store.put('120363@g.us', '628111@s.whatsapp.net', { keyword: 'satu', items: results })
  const conn = fakeConn()
  const ctx = {
    conn, nekopoiSessions: store,
    nekopoiFetch: fakeFetch({ 'https://nekopoi.care/judul-dua/': DETAIL_HTML }),
  }
  const m = fakeMsg({ text: '2' })
  assert.equal(await nekopoiHandler.before(m, ctx), true)
  assert.equal(conn.sent.length, 1, 'detail terkirim sebagai gambar + caption')
  assert.ok(store.get(m.chat, m.sender), 'sesi tetap buka sesudah memilih')

  const out = fakeMsg({ text: '9' })
  assert.equal(await nekopoiHandler.before(out, ctx), true)
  assert.match(out.replies[0], /di luar daftar \(1–2\)/)

  const close = fakeMsg({ text: 'batal' })
  assert.equal(await nekopoiHandler.before(close, ctx), true)
  assert.equal(store.get(m.chat, m.sender), null)
  assert.match(close.replies[0], /ditutup/)
})

test('before: tanpa sesi / teks biasa / pesan sendiri -> dilewati', async () => {
  const store = createNekopoiSessionStore()
  const ctx = { conn: fakeConn(), nekopoiSessions: store, nekopoiFetch: fakeFetch({}) }
  assert.equal(await nekopoiHandler.before(fakeMsg({ text: '1' }), ctx), false, 'angka tanpa sesi')
  assert.equal(await nekopoiHandler.before(fakeMsg({ text: 'batal' }), ctx), false, 'batal tanpa sesi')
  store.put('120363@g.us', '628111@s.whatsapp.net', { keyword: 'x', items: parseSearchResults(SEARCH_HTML) })
  assert.equal(await nekopoiHandler.before(fakeMsg({ text: 'halo' }), ctx), false, 'teks biasa bersesi pun dilewati')
  assert.equal(await nekopoiHandler.before(fakeMsg({ text: '1', fromMe: true }), ctx), false, 'pesan bot sendiri')
})
