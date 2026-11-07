import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseOngoingJson, buildLatestUrl, formatOngoingLabel, parseSearchPage, parseDetailPage } from '../lib/kuramanime/catalog.js'
import { setFlow, getFlow, clearFlow, flowKey, advanceFlow, formatProvidersView, isAnimeWhitelisted, animeAccess, assertAnimeAccess, animeCooldownLeft, assertAnimeCooldown, markAnimeUse, animeDownloadsToday, reserveAnimeDownload, releaseAnimeDownload, animeDayKey, ANIME_DAILY_LIMIT } from '../lib/helpers/animeFlow.js'
import ongoingHandler from '../plugins/anime/ongoing.js'
import cariHandler from '../plugins/anime/carianime.js'
import animeHandler from '../plugins/anime/anime.js'
import pilihHandler from '../plugins/anime/pilih.js'

// ─── katalog: ongoing ────────────────────────────────────────────────────────

const ongoingFixture = {
  ongoingAnimes: {
    current_page: 1, last_page: 9, total: 159, next_page_url: 'x', prev_page_url: null,
    data: [
      { id: 5139, slug: 'li-xiongmao', title: 'Li Xiongmao', quality: 'HD', is_new_release: true, posts: [{ type: 'Episode', episode: 15, episode_decimal: null, episode_batch: null }] },
      { id: 200, slug: 'batch-anime', title: 'Batch Anime', quality: null, posts: [{ type: 'Batch', episode: null, episode_batch: '1-12' }] }
    ]
  }
}

test('catalog ongoing: parse JSON + buildLatestUrl episode & batch', () => {
  const r = parseOngoingJson(JSON.stringify(ongoingFixture))
  assert.equal(r.items.length, 2)
  assert.equal(r.pagination.totalPages, 9)
  assert.equal(buildLatestUrl(r.items[0]), 'https://v20.kuramanime.ing/anime/5139/li-xiongmao/episode/15')
  assert.equal(buildLatestUrl(r.items[1]), 'https://v20.kuramanime.ing/anime/200/batch-anime/batch/1-12')
  assert.match(formatOngoingLabel(r.items[0]), /Li Xiongmao \(HD\) — Ep 15 \[BARU\]/)
})

// ─── katalog: pencarian & detail ─────────────────────────────────────────────

test('catalog search: parse JSON animes.data', () => {
  const raw = JSON.stringify({ animes: { current_page: 1, last_page: 1, total: 1, next_page_url: null, prev_page_url: null, data: [{ id: 5139, slug: 'li-xiongmao', title: 'Li Xiongmao', score: 8.1, quality: 'HD' }] } })
  const r = parseSearchPage(raw)
  assert.equal(r.items[0].url, 'https://v20.kuramanime.ing/anime/5139/li-xiongmao')
  assert.equal(r.items[0].score, 8.1)
})

test('catalog detail: judul + daftar episode dari data-content', () => {
  const html = `<div class="anime__details__title"><h3>Li Xiongmao</h3><span>Alt Title</span></div>
<input id="animeId" value="5139">
<div id="episodeLists" data-content="<a href='https://v20.kuramanime.ing/anime/5139/li-xiongmao/episode/15'>Episode 15</a> <a href='https://v20.kuramanime.ing/anime/5139/li-xiongmao/episode/14'>Episode 14</a>"></div>
<div id="episodeBatchLists" data-content=""></div>`
  const d = parseDetailPage(html)
  assert.equal(d.title, 'Li Xiongmao')
  assert.equal(d.episodeList.length, 2)
  assert.equal(d.episodeList[0].label, 'Episode 15')
})

// ─── alur pilih ──────────────────────────────────────────────────────────────

const episodePageStub = {
  title: 'Li Xiongmao Episode 15',
  contentError: null,
  downloads: [
    { quality: 'MP4 360p (Hardsub) — (98.88 MB)', text: 'kDrive', host: 'v1.kuramadrive.com', url: 'https://v1.kuramadrive.com/kdrive/ID360' },
    { quality: 'MP4 360p (Hardsub) — (98.88 MB)', text: 'Pixeldrain', host: 'pixeldrain.com', url: 'https://pixeldrain.com/d/PD1' },
    { quality: 'MP4 720p (Hardsub) — (273.85 MB)', text: 'Anjay', host: 'example.net', url: 'https://example.net/f/1' }
  ],
  streaming: []
}
const detectStub = url => url.includes('kuramadrive') ? 'kdrive' : url.includes('pixeldrain') ? 'pixeldrain' : null
const deps = {
  fetchEpisodePage: async () => episodePageStub,
  fetchAnimeDetail: async () => ({ title: 'Li Xiongmao', episodeList: [{ label: 'Episode 15', url: 'https://v20.kuramanime.ing/anime/5139/li-xiongmao/episode/15' }], batchList: [] }),
  detectProvider: detectStub,
  resolveKdrive: async (url, { episodeUrl }) => ({ fileUrl: 'https://anisphia.my.id/kdrive/ID360/file.mp4', via: 'episode-page' })
}

test('flow: ongoing -> providers -> unduh kdrive ter-resolusi / pixeldrain langsung / asing jadi link', async () => {
  const s1 = await advanceFlow({ stage: 'ongoing', items: ongoingFixture.ongoingAnimes.data }, 1, deps)
  assert.equal(s1.flow.stage, 'providers')
  assert.match(s1.text, /MP4 360p/)
  assert.match(s1.text, /kDrive ✅/)

  const dlKd = await advanceFlow(s1.flow, 1, deps)
  assert.deepEqual(dlKd, { type: 'download', provider: 'kdrive', url: 'https://anisphia.my.id/kdrive/ID360/file.mp4' })

  const dlPd = await advanceFlow(s1.flow, 2, deps)
  assert.deepEqual(dlPd, { type: 'download', provider: 'pixeldrain', url: 'https://pixeldrain.com/d/PD1' })

  const link = await advanceFlow(s1.flow, 3, deps)
  assert.equal(link.type, 'link')
  assert.match(link.text, /example\.net/)
})

test('flow: kDrive MKV langsung jadi link (tidak dijanjikan bisa diunduh)', async () => {
  const mkvFlow = {
    stage: 'providers', episodeUrl: 'https://v20.kuramanime.ing/anime/5139/li-xiongmao/episode/15',
    items: [{ quality: 'MKV 720p (Softsub) — (324.27 MB)', text: 'kDrive', host: 'v1.kuramadrive.com', url: 'https://v1.kuramadrive.com/kdrive/MKV1' }]
  }
  const out = await advanceFlow(mkvFlow, 1, deps)
  assert.equal(out.type, 'link')
  assert.match(out.text, /MKV/)
  assert.match(formatProvidersView({ title: 'X', downloads: mkvFlow.items }, detectStub), /kDrive 🔗/)
})

test('flow: search -> episodes -> providers', async () => {
  const s1 = await advanceFlow({ stage: 'search', items: [{ title: 'Li Xiongmao', url: 'https://v20.kuramanime.ing/anime/5139/li-xiongmao' }] }, 1, deps)
  assert.equal(s1.flow.stage, 'episodes')
  const s2 = await advanceFlow(s1.flow, 1, deps)
  assert.equal(s2.flow.stage, 'providers')
})

test('regresi 2026-10-23: tahap search TANPA deps.fetchAnimeDetail tidak boleh melempar "tidak tersedia"', async () => {
  // Di produksi plugins/anime/pilih.js memanggil advanceFlow TANPA deps —
  // tahap search dulu melempar 'fetchAnimeDetail tidak tersedia' sebelum
  // sempat mengambil apa pun, sementara tes unit selalu menyuntikkan stub
  // sehingga lolos. Sekarang tahap ini memakai fetchAnimeDetail asli dari
  // catalog; URL lokal tak terjangkau ini membuat panggilan aslinya gagal
  // dengan error jaringan — yang penting BUKAN error pengkabelan itu.
  await assert.rejects(
    advanceFlow({ stage: 'search', items: [{ title: 'X', url: 'http://127.0.0.1:9/anime/0/x' }] }, 1, {}),
    err => !/fetchAnimeDetail tidak tersedia/.test(err?.message || String(err))
  )
})

test('flow: nomor di luar jangkauan ditolak; state kedaluwarsa hilang', async () => {
  await assert.rejects(advanceFlow({ stage: 'ongoing', items: [1] }, 5, deps), /Nomor tidak valid/)
  setFlow('chat|user', { stage: 'ongoing', items: [] })
  assert.ok(getFlow('chat|user'))
  clearFlow('chat|user')
  assert.equal(getFlow('chat|user'), null)
})

// ─── metadata plugin ─────────────────────────────────────────────────────────

test('plugin anime: tag anime, BUKAN founder-only (gerbang whitelist di handler), perintah sesuai', () => {
  for (const h of [ongoingHandler, cariHandler, animeHandler, pilihHandler]) {
    assert.deepEqual(h.tags, ['anime'])
    assert.equal(h.founder, undefined)
  }
  assert.match('ongoing', ongoingHandler.command)
  assert.match('carianime', cariHandler.command)
  assert.match('anime', animeHandler.command)
  assert.match('pilih', pilihHandler.command)
})

// ─── Akses whitelist & limit (2026-11-05) ────────────────────────────────────

test('anime whitelist: cocok via nomor polos, JID, LID, dan resolver identitas', () => {
  assert.equal(isAnimeWhitelisted('6289528749986@s.whatsapp.net', ['6289528749986']), true)
  assert.equal(isAnimeWhitelisted('6289528749986@s.whatsapp.net', ['6289528749986@s.whatsapp.net']), true)
  assert.equal(isAnimeWhitelisted('147368951459939@lid', ['147368951459939@lid']), true)
  assert.equal(isAnimeWhitelisted('628111@s.whatsapp.net', ['6289528749986']), false)
  assert.equal(isAnimeWhitelisted('628111@s.whatsapp.net', []), false)
  // Resolver identitas menjembatani PN <-> LID walau entri != pengirim.
  const same = (a, b) => (a === '999@lid' && b === '628999@s.whatsapp.net') || a === b
  assert.equal(isAnimeWhitelisted('628999@s.whatsapp.net', ['999@lid'], same), true)
})

test('anime access: founder exempt; user whitelist + gerbang grup', () => {
  const prev = globalThis.anime
  globalThis.anime = { users: ['6289528749986'], groups: ['120363111@g.us'] }
  try {
    const dm = { sender: '6289528749986@s.whatsapp.net', chat: '6289528749986@s.whatsapp.net', isGroup: false }
    const grupOk = { sender: '6289528749986@s.whatsapp.net', chat: '120363111@g.us', isGroup: true }
    const grupTutup = { sender: '6289528749986@s.whatsapp.net', chat: '120363222@g.us', isGroup: true }
    const asing = { sender: '628111@s.whatsapp.net', chat: '628111@s.whatsapp.net', isGroup: false }
    assert.deepEqual(animeAccess(dm, {}), { exempt: false, ok: true })
    assert.deepEqual(animeAccess(grupOk, {}), { exempt: false, ok: true })
    assert.equal(animeAccess(grupTutup, {}).reason, 'group')
    assert.equal(animeAccess(asing, {}).reason, 'user')
    assert.equal(animeAccess(asing, { isFounder: true }).exempt, true)
    assert.throws(() => assertAnimeAccess(asing, {}), /whitelist/)
    assert.throws(() => assertAnimeAccess(grupTutup, {}), /grup ini/)
  } finally {
    if (prev === undefined) delete globalThis.anime; else globalThis.anime = prev
  }
})

test('anime cooldown: sisa waktu dari animeLastAt, 0 sesudah 60 detik', () => {
  const t = 1_700_000_000_000
  const rec = {}
  assert.equal(animeCooldownLeft(rec, t), 0)
  markAnimeUse(rec, t)
  assert.equal(rec.animeLastAt, t)
  assert.equal(animeCooldownLeft(rec, t + 30_000), 30_000)
  assert.equal(animeCooldownLeft(rec, t + 60_000), 0)
  assert.throws(() => assertAnimeCooldown(rec, t + 1_000), /Cooldown anime/)
  assert.doesNotThrow(() => assertAnimeCooldown(rec, t + 61_000))
})

test('anime kuota: reservasi 3x, ke-4 ditolak, release mengembalikan, hari baru mereset', () => {
  const tz = 'Asia/Jakarta'
  const now = Date.UTC(2026, 10, 5, 10, 0, 0)
  const rec = {}
  for (let i = 0; i < ANIME_DAILY_LIMIT; i++) reserveAnimeDownload(rec, now, tz)
  assert.equal(animeDownloadsToday(rec, now, tz), 3)
  assert.throws(() => reserveAnimeDownload(rec, now, tz), /Kuota unduhan anime/)
  releaseAnimeDownload(rec, now, tz)
  assert.equal(animeDownloadsToday(rec, now, tz), 2)
  reserveAnimeDownload(rec, now, tz)
  assert.equal(animeDownloadsToday(rec, now, tz), 3)
  // Record dari hari lama dianggap 0 dan tereset saat reservasi berikutnya.
  const lama = { animeDlDay: '2000-01-01', animeDlCount: 3 }
  assert.equal(animeDownloadsToday(lama, now, tz), 0)
  reserveAnimeDownload(lama, now, tz)
  assert.equal(lama.animeDlDay, animeDayKey(now, tz))
  assert.equal(lama.animeDlCount, 1)
})

test('animeDayKey: batas hari mengikuti zona waktu', () => {
  assert.equal(animeDayKey(Date.UTC(2026, 10, 5, 16, 30), 'Asia/Jakarta'), '2026-11-05')
  assert.equal(animeDayKey(Date.UTC(2026, 10, 5, 17, 30), 'Asia/Jakarta'), '2026-11-06')
})

test('pilih: user non-whitelist ditolak di gerbang, job tidak jalan', async () => {
  const prev = globalThis.anime
  globalThis.anime = { users: [], groups: [] }
  const m = {
    chat: '628111@s.whatsapp.net', sender: '628111@s.whatsapp.net', isGroup: false,
    text: '1', fromMe: false, reply: async () => {},
  }
  setFlow(flowKey(m), { stage: 'providers', title: 'Ep', episodeUrl: 'https://kuramanime.example/episode/1', items: [{ url: 'https://pixeldrain.com/u/abc', quality: '720p', text: 'Pixeldrain' }] })
  let ran = false
  const ctx = { conn: {}, text: '1', usedPrefix: '.', command: 'pilih', isFounder: false, isOwner: false, userData: {}, runDownloadJob: async () => { ran = true; return { kind: 'file' } } }
  try {
    await assert.rejects(pilihHandler(m, ctx), /whitelist/)
    assert.equal(ran, false)
  } finally {
    clearFlow(flowKey(m))
    if (prev === undefined) delete globalThis.anime; else globalThis.anime = prev
  }
})

test('pilih: user whitelist dengan kuota habis ditolak sebelum job jalan', async () => {
  const prev = globalThis.anime
  globalThis.anime = { users: ['6289528749986'], groups: [] }
  const m = {
    chat: '6289528749986@s.whatsapp.net', sender: '6289528749986@s.whatsapp.net', isGroup: false,
    text: '1', fromMe: false, reply: async () => {},
  }
  setFlow(flowKey(m), { stage: 'providers', title: 'Ep', episodeUrl: 'https://kuramanime.example/episode/1', items: [{ url: 'https://pixeldrain.com/u/abc', quality: '720p', text: 'Pixeldrain' }] })
  let ran = false
  const userData = { animeDlDay: animeDayKey(Date.now()), animeDlCount: ANIME_DAILY_LIMIT, animeLastAt: 0 }
  const ctx = { conn: {}, text: '1', usedPrefix: '.', command: 'pilih', isFounder: false, isOwner: false, userData, runDownloadJob: async () => { ran = true; return { kind: 'file' } } }
  try {
    await assert.rejects(pilihHandler(m, ctx), /Kuota unduhan anime/)
    assert.equal(ran, false)
  } finally {
    clearFlow(flowKey(m))
    if (prev === undefined) delete globalThis.anime; else globalThis.anime = prev
  }
})
