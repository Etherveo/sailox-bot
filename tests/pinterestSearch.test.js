import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSearchResponse, searchPins, SEARCH_URL } from '../lib/downloader/engines/pinterest.js'

// Fixture meniru resource_response.data.results dari
// id.pinterest.com/resource/BaseSearchResource/get/ (bentuk legacy
// downloader-pinterest.js): 1 pin gambar, 1 pin video, 1 pin tanpa
// gambar (harus tersaring), 1 pin tanpa grid_title (fallback deskripsi).
const searchFixture = {
  resource_response: {
    data: {
      results: [
        {
          id: 'e1_AfqPShzXLlNkaGvuGuUDEx6K_LxitXKv4nMgbR9zQxT',
          grid_title: 'Wallpaper Anime Keren',
          description: 'Deskripsi pin gambar',
          images: {
            orig: { url: 'https://i.pinimg.com/originals/aa/bb/cc/aabbcc.jpg' },
            '736x': { url: 'https://i.pinimg.com/736x/aa/bb/cc/aabbcc.jpg' },
            '474x': { url: 'https://i.pinimg.com/474x/aa/bb/cc/aabbcc.jpg' },
          },
          pinner: { full_name: 'Si Pengunggah', username: 'pengunggah' },
          board: { name: 'Anime', url: '/pengunggah/anime/' },
        },
        {
          id: 'e1_AfqPShwIHCaciZuTeuXRnWdWMw8XrsUmblobEgc5SaAcn',
          grid_title: '',
          description: 'Video anime pendek',
          images: { '736x': { url: 'https://i.pinimg.com/736x/dd/ee/ff/ddeeff.jpg' } },
          story_pin_data: {
            pages: [{ blocks: [{ video: { video_list: { V_HLSV3_MOBILE: { url: 'https://v1.pinimg.com/videos/mc/720p/dd/vid.mp4' } } } }] }],
          },
          pinner: { full_name: 'Video Maker', username: 'videomaker' },
          board: { name: 'Video', url: '/videomaker/video/' },
        },
        {
          id: 'e1_AfqPShzKS7KhG2naprUvWb37RyVPy2xAwXZMMbB6oZFhC',
          grid_title: 'Pin tanpa gambar',
          description: 'Tidak ada images sama sekali',
          images: {},
          pinner: { full_name: 'Hantu', username: 'hantu' },
        },
        {
          id: 'e1_AfqPShwIHCaciZuTeuXRnWdWMw8XrsUmblobEgc5SaBz2',
          grid_title: '   ',
          description: 'Hanya deskripsi, tanpa judul',
          images: { '474x': { url: 'https://i.pinimg.com/474x/11/22/33/112233.jpg' } },
          pinner: null,
          board: null,
        },
      ],
    },
  },
}

test('pinterest search: parseSearchResponse memetakan pin gambar/video, menyaring tanpa gambar', () => {
  const out = parseSearchResponse(searchFixture)
  assert.equal(out.length, 3, 'pin tanpa gambar tersaring, 3 sisanya lolos')
  // Pin gambar: orig didahulukan, judul + pinner + board + pinUrl terisi.
  assert.equal(out[0].imageUrl, 'https://i.pinimg.com/originals/aa/bb/cc/aabbcc.jpg')
  assert.equal(out[0].title, 'Wallpaper Anime Keren')
  assert.equal(out[0].pinner, 'Si Pengunggah')
  assert.equal(out[0].pinnerUsername, 'pengunggah')
  assert.equal(out[0].boardName, 'Anime')
  assert.equal(out[0].pinUrl, 'https://id.pinterest.com/pin/e1_AfqPShzXLlNkaGvuGuUDEx6K_LxitXKv4nMgbR9zQxT')
  assert.equal(out[0].videoUrl, null)
  // Pin video: 736x dipakai (orig tidak ada), videoUrl dari story_pin_data.
  assert.equal(out[1].imageUrl, 'https://i.pinimg.com/736x/dd/ee/ff/ddeeff.jpg')
  assert.equal(out[1].title, 'Video anime pendek', 'grid_title kosong -> fallback deskripsi')
  assert.equal(out[1].videoUrl, 'https://v1.pinimg.com/videos/mc/720p/dd/vid.mp4')
  // Pin tanpa grid_title (cuma spasi): judul di-trim lalu fallback deskripsi.
  assert.equal(out[2].title, 'Hanya deskripsi, tanpa judul')
  assert.equal(out[2].imageUrl, 'https://i.pinimg.com/474x/11/22/33/112233.jpg')
  assert.equal(out[2].pinner, null)
  assert.equal(out[2].boardName, null)
})

test('pinterest search: parseSearchResponse mengembalikan [] untuk respons kosong/rusak', () => {
  assert.deepEqual(parseSearchResponse(null), [])
  assert.deepEqual(parseSearchResponse({}), [])
  assert.deepEqual(parseSearchResponse({ resource_response: {} }), [])
  assert.deepEqual(parseSearchResponse({ resource_response: { data: { results: 'bukan array' } } }), [])
  assert.deepEqual(parseSearchResponse({ resource_response: { data: { results: [] } } }), [])
})

test('pinterest search: searchPins memakai sesi dummy bawaan bila cookie tidak dioper', async () => {
  const seen = {}
  const fetchFn = async (url, opts = {}) => {
    seen.headers = opts.headers
    return Response.json(searchFixture)
  }
  const out = await searchPins('wallpaper anime', { fetchFn })
  // Pasangan dummy (BUKAN kredensial) terkirim apa adanya + cocok.
  assert.equal(seen.headers.cookie, '_pinterest_sess=...; csrftoken=...')
  assert.equal(seen.headers['x-csrftoken'], '...')
  assert.equal(out.length, 3)
  await assert.rejects(() => searchPins('   ', { fetchFn }), /Kata kunci pencarian kosong/)
  await assert.rejects(() => searchPins('wallpaper anime', { cookie: '', csrftoken: '', fetchFn }), /tidak boleh dikosongkan/)
})

test('pinterest search: searchPins POST ke BaseSearchResource dengan cookie + csrftoken, hasil terurai', async () => {
  const seen = {}
  const fetchFn = async (url, opts = {}) => {
    seen.url = String(url)
    seen.method = opts.method
    seen.headers = opts.headers
    seen.body = new URLSearchParams(String(opts.body))
    return Response.json(searchFixture)
  }
  const out = await searchPins('wallpaper anime', { cookie: '_pinterest_sess=SESI; csrftoken=CSRF', csrftoken: 'CSRF', pageSize: 10, fetchFn })
  assert.equal(seen.url, SEARCH_URL)
  assert.equal(seen.method, 'POST')
  assert.equal(seen.headers.cookie, '_pinterest_sess=SESI; csrftoken=CSRF')
  assert.equal(seen.headers['x-csrftoken'], 'CSRF')
  assert.equal(seen.headers['x-requested-with'], 'XMLHttpRequest')
  assert.equal(seen.headers['content-type'], 'application/x-www-form-urlencoded')
  assert.equal(seen.body.get('source_url'), '/search/pins/?q=wallpaper%20anime&rs=typed')
  const data = JSON.parse(seen.body.get('data'))
  assert.equal(data.options.query, 'wallpaper anime')
  assert.equal(data.options.scope, 'pins')
  assert.equal(data.options.page_size, 10)
  assert.equal(out.length, 3)
  assert.equal(out[0].title, 'Wallpaper Anime Keren')
})

test('pinterest search: searchPins melempar jelas saat Pinterest menolak / respons bukan JSON', async () => {
  const forbidden = async () => new Response('No CSRF cookie', { status: 403 })
  await assert.rejects(
    () => searchPins('wallpaper anime', { cookie: 'x', csrftoken: 'y', fetchFn: forbidden }),
    /Pinterest merespons status 403/,
  )
  const notJson = async () => new Response('<!DOCTYPE html>', { status: 200, headers: { 'content-type': 'text/html' } })
  await assert.rejects(
    () => searchPins('wallpaper anime', { cookie: 'x', csrftoken: 'y', fetchFn: notJson }),
    /bukan JSON/,
  )
})
