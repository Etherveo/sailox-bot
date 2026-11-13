import { test } from 'node:test'
import assert from 'node:assert/strict'
import pinHandler from '../plugins/downloader/pin.js'
import { fakeConn } from './fixtures.js'

// Plugin .pin cabang kata kunci: pencarian stub via ctx.pinterestSearch
// (tanpa fetch, tanpa antrean .dl). Pengiriman mengikuti UX legacy:
// 1 hasil = gambar + caption; >1 = album ala runJob (parent {album} +
// albumParentKey per media, caption di media pertama).

const fakeM = () => ({ chat: 'tes@s.whatsapp.net', sender: 'founder@s.whatsapp.net', reply: async () => {} })

const makeResults = n => Array.from({ length: n }, (_, i) => ({
  id: `e1_pin${i + 1}`,
  title: `Judul ${i + 1}`,
  description: `Deskripsi ${i + 1}`,
  imageUrl: `https://i.pinimg.com/originals/aa/bb/cc/img${i + 1}.jpg`,
  videoUrl: i === 0 ? 'https://v1.pinimg.com/videos/mc/720p/vid1.mp4' : null,
  pinner: `Pengunggah ${i + 1}`,
  pinnerUsername: `user${i + 1}`,
  boardName: 'Board',
  pinUrl: `https://id.pinterest.com/pin/e1_pin${i + 1}`,
}))

// fakeConn mencatat return value tiap sendMessage supaya albumParentKey
// bisa dicocokkan dengan key pesan parent.
function tracingConn() {
  const conn = fakeConn()
  const sentKeys = []
  const origSend = conn.sendMessage.bind(conn)
  conn.sendMessage = async (jid, data, options) => {
    const r = await origSend(jid, data, options)
    sentKeys.push(r.key)
    return r
  }
  return { conn, sentKeys }
}

test('pin search: 1 hasil dikirim sebagai gambar + caption judul/uploader/link', async () => {
  const { conn } = tracingConn()
  const m = fakeM()
  await pinHandler(m, { conn, text: 'wallpaper anime', usedPrefix: '.', command: 'pin', pinterestSearch: async () => makeResults(1) })
  assert.equal(conn.calls.length, 1)
  const [call] = conn.calls
  assert.equal(call.data.image.url, 'https://i.pinimg.com/originals/aa/bb/cc/img1.jpg')
  assert.match(call.data.caption, /Query: wallpaper anime/)
  assert.match(call.data.caption, /Title: Judul 1/)
  assert.match(call.data.caption, /Uploader: Pengunggah 1/)
  assert.match(call.data.caption, /https:\/\/id\.pinterest\.com\/pin\/e1_pin1/)
})

test('pin search: .pin 3 kirim album 3 dari 5 hasil (parent + albumParentKey)', async () => {
  const { conn, sentKeys } = tracingConn()
  const m = fakeM()
  let seenQuery
  await pinHandler(m, {
    conn, text: '3 wallpaper anime', usedPrefix: '.', command: 'pin',
    pinterestSearch: async (q, opts) => { seenQuery = q; assert.equal(opts.pageSize, 10); return makeResults(5) },
  })
  assert.equal(seenQuery, 'wallpaper anime')
  assert.equal(conn.calls.length, 4, '1 parent album + 3 media')
  const [parent, ...media] = conn.calls
  assert.deepEqual(parent.data.album, { expectedImageCount: 3, expectedVideoCount: 0 })
  assert.equal(media.length, 3)
  for (const [i, call] of media.entries()) {
    assert.equal(call.data.image.url, `https://i.pinimg.com/originals/aa/bb/cc/img${i + 1}.jpg`)
    assert.equal(call.data.albumParentKey, sentKeys[0], 'media terikat ke key pesan parent')
  }
  assert.match(media[0].data.caption, /Total: 3 gambar/)
  assert.equal(media[1].data.caption, '')
  assert.equal(media[2].data.caption, '')
})

test('pin search: hasil lebih sedikit dari jumlah diminta -> kirim seadanya', async () => {
  const { conn } = tracingConn()
  const m = fakeM()
  await pinHandler(m, { conn, text: '3 wallpaper anime', usedPrefix: '.', command: 'pin', pinterestSearch: async () => makeResults(2) })
  assert.equal(conn.calls.length, 3, '1 parent + 2 media')
  assert.equal(conn.calls[0].data.album.expectedImageCount, 2)
  assert.match(conn.calls[1].data.caption, /Total: 2 gambar/)
})

test('pin search: jumlah > 5 ditolak sebelum search; query kosong ditolak; 0 hasil ditolak', async () => {
  const { conn } = tracingConn()
  const m = fakeM()
  let calls = 0
  const counting = async () => { calls++; return makeResults(5) }
  await assert.rejects(
    pinHandler(m, { conn, text: '6 wallpaper anime', usedPrefix: '.', command: 'pin', pinterestSearch: counting }),
    /Maksimum 5/,
  )
  assert.equal(calls, 0, 'search tidak dipanggil saat jumlah melebihi batas')
  await assert.rejects(
    pinHandler(m, { conn, text: '3', usedPrefix: '.', command: 'pin', pinterestSearch: counting }),
    /Kasih kata kunci/,
  )
  assert.equal(calls, 0, 'search tidak dipanggil saat query kosong')
  await assert.rejects(
    pinHandler(m, { conn, text: 'wallpaper anime', usedPrefix: '.', command: 'pin', pinterestSearch: async () => [] }),
    /ga ketemu/,
  )
  await assert.rejects(
    pinHandler(m, { conn, text: 'wallpaper anime', usedPrefix: '.', command: 'pin', pinterestSearch: async () => [{ title: 'tanpa gambar' }] }),
    /ga ketemu/,
    'hasil tanpa imageUrl ikut tersaring',
  )
})

test('pin search: pin video tetap dikirim sebagai gambar (thumbnail, ala legacy)', async () => {
  const { conn } = tracingConn()
  const m = fakeM()
  await pinHandler(m, { conn, text: 'video anime', usedPrefix: '.', command: 'pin', pinterestSearch: async () => makeResults(1) })
  assert.equal(conn.calls.length, 1)
  assert.equal(conn.calls[0].data.image.url, 'https://i.pinimg.com/originals/aa/bb/cc/img1.jpg')
  assert.ok(!('video' in conn.calls[0].data), 'tidak ada field video di pesan')
})

test('pin search: parent album gagal -> media dikirim satu per satu tanpa albumParentKey', async () => {
  const { conn } = tracingConn()
  const m = fakeM()
  const origSend = conn.sendMessage.bind(conn)
  conn.sendMessage = async (jid, data, options) => {
    if (data.album) throw new Error('album gagal')
    return origSend(jid, data, options)
  }
  await pinHandler(m, { conn, text: '2 wallpaper anime', usedPrefix: '.', command: 'pin', pinterestSearch: async () => makeResults(2) })
  assert.equal(conn.calls.length, 2, 'parent gagal tidak tercatat, 2 media tetap terkirim')
  assert.ok(!('albumParentKey' in conn.calls[0].data))
  assert.ok(!('albumParentKey' in conn.calls[1].data))
  assert.match(conn.calls[0].data.caption, /Total: 2 gambar/)
})

test('pin search: metadata handler', () => {
  assert.match('pin', pinHandler.command)
  assert.match('pinterest', pinHandler.command)
  assert.ok(pinHandler.help.some(h => h.includes('<kata kunci>')))
  assert.ok(pinHandler.help.some(h => h.includes('<jumlah>')))
  assert.deepEqual(pinHandler.tags, ['downloader'])
})
