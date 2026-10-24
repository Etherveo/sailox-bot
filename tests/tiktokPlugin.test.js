// tests/tiktokPlugin.test.js — klaim manual antrean (.tt), store follow-up,
// dan handler .tt/.tiktok (pakai engine .dl yang sama, tanpa jaringan nyata).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createDownloadQueue } from '../lib/downloader/queue.js'
import { createTiktokFollowupStore } from '../lib/helpers/tiktokFollowup.js'
import tiktokHandler from '../plugins/downloader/tiktok.js'

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-tt-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

// ─── Klaim manual antrean ──────────────────────────────────────────────────

test('antrean: klaim manual (.tt) tidak diproses pump, tapi memblokir .dl untuk link yang sama', async t => {
  const dir = await tmpDir(t)
  let processed = 0
  const queue = createDownloadQueue({ file: path.join(dir, 'q.json'), processJob: async () => { processed++; return {} } })
  const { job } = await queue.enqueue({ url: 'https://vt.tiktok.com/abc/', provider: 'tiktok', chat: 'c', sender: 'A', manual: true })
  queue.kick()
  await new Promise(r => setTimeout(r, 150))
  assert.equal(processed, 0, 'pump .dl tidak boleh memproses klaim manual')
  assert.equal((await queue.snapshot()).jobs.length, 1)
  // .dl dengan link yang sama ditolak selama klaim hidup.
  await assert.rejects(queue.enqueue({ url: 'https://vt.tiktok.com/abc/', provider: 'tiktok', chat: 'c', sender: 'B' }), /sudah ada di antrean/)
  // Selesai -> keluar antrean + cooldown 60 detik memblokir pengajuan ulang.
  await queue.finish(job.id, { status: 'done' })
  assert.equal((await queue.snapshot()).jobs.length, 0)
  await assert.rejects(queue.enqueue({ url: 'https://vt.tiktok.com/abc/', provider: 'tiktok', chat: 'c', sender: 'B' }), /baru saja diproses/)
})

test('antrean: klaim manual kedaluwarsa dibuang saat antrean berikutnya masuk', async t => {
  const dir = await tmpDir(t)
  const queue = createDownloadQueue({ file: path.join(dir, 'q.json'), processJob: async () => ({}) })
  await queue.enqueue({ url: 'https://vt.tiktok.com/exp/', provider: 'tiktok', chat: 'c', sender: 'A', manual: true, expiresAt: Date.now() - 1 })
  const out = await queue.enqueue({ url: 'https://vt.tiktok.com/exp/', provider: 'tiktok', chat: 'c', sender: 'B', manual: true })
  assert.ok(out.job.id, 'klaim kedaluwarsa tidak boleh memblokir link selamanya')
  // Biarkan pump (yang dipicu enqueue) menyelesaikan tulis jejaknya dulu
  // sebelum t.after menghapus folder tmp — kalau tidak, rmdir balapan.
  await new Promise(r => setTimeout(r, 150))
})

// ─── Store follow-up ───────────────────────────────────────────────────────

test('followup .tt: simpan, ambil, hapus, dan kedaluwarsa 40 detik', () => {
  let now = 1000
  const store = createTiktokFollowupStore({ now: () => now })
  store.put('chat1', 'S', { videoHD: 'https://cdn/hd.mp4', audio: null, title: 'T' })
  assert.equal(store.get('chat1', 'S').videoHD, 'https://cdn/hd.mp4')
  assert.equal(store.get('chat2', 'S'), null, 'chat lain tidak ikut terpicu')
  now += 40 * 1000
  assert.equal(store.get('chat1', 'S'), null, 'kedaluwarsa setelah 40 detik')
  store.put('chat1', 'S', { videoHD: null, audio: 'https://cdn/a.mp3', title: 'T' })
  store.delete('chat1', 'S')
  assert.equal(store.get('chat1', 'S'), null)
})

// ─── Handler .tt + before 'hd' ─────────────────────────────────────────────

test('plugin .tt: kirim SD, simpan follow-up, balas hd kirim HD lalu hapus entri', async () => {
  const savetikHtml = '<h3>Judul Tes</h3><div class="dl-action">' +
    '<a href="https://cdn.test/hd.mp4">Download MP4 HD</a>' +
    '<a href="https://cdn.test/sd1.mp4">Download MP4 [1]</a></div>'
  const realFetch = globalThis.fetch
  globalThis.fetch = async url => {
    if (String(url).includes('savetik.io/api')) return Response.json({ status: 'ok', data: savetikHtml })
    if (String(url).includes('cdn.test/')) {
      // Media resolver: .tt mengunduhnya dulu ke disk (fetch biasa),
      // BUKAN sendFile dari URL — jadi stub harus mengembalikan byte.
      return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { 'content-type': 'video/mp4' } })
    }
    throw new Error('URL tak dikenal di stub: ' + url)
  }
  try {
    const sentFiles = []
    const replies = []
    const finished = []
    const fakeConn = {
      sendFile: async (chat, src, name, caption) => { sentFiles.push({ src, name, caption }) },
      sendMessage: async () => ({}),
    }
    const fakeQueue = {
      enqueue: async () => ({ job: { id: 7 } }),
      finish: async (id, patch) => { finished.push(patch.status) },
    }
    const m = {
      chat: 'chat-tt', sender: 'S-tt', pushName: 'V',
      key: { remoteJid: 'chat-tt', id: 'msg1' },
      conn: fakeConn, fromMe: false,
      reply: async text => { replies.push(text) },
    }
    await tiktokHandler(m, { conn: fakeConn, text: 'https://vt.tiktok.com/abc/', downloadQueue: fakeQueue })
    assert.equal(sentFiles.length, 1)
    // Perbaikan 2026-10-24: .tt TIDAK lagi sendFile dari URL resolver
    // (jalur itu ditolak validasi DNS fetchPublicBuffer di sel VM) —
    // media diunduh dulu ke disk, jadi src harus file lokal .mp4,
    // dan folder tmp-nya sudah dibersihkan setelah terkirim.
    assert.ok(!String(sentFiles[0].src).startsWith('http'), 'src harus file lokal, bukan URL resolver')
    assert.ok(String(sentFiles[0].src).endsWith('.mp4'), 'src lokal harus .mp4')
    assert.equal(sentFiles[0].name, 'tiktok.mp4')
    await assert.rejects(fs.access(sentFiles[0].src), 'folder tmp .tt harus dibersihkan setelah kirim')
    assert.ok(replies.some(r => r.includes('hd') && r.includes('mp3')), 'prompt follow-up terkirim')
    assert.ok(!replies.some(r => /balas/i.test(r)), 'prompt TIDAK boleh menyuruh reply — reply ke pesan bot memicu trigger Ryn (bentrok); cukup kirim teks biasa')
    assert.deepEqual(finished, ['done'])
    // Balas 'hd' -> kirim HD, entri terhapus; 'hd' kedua -> tidak bereaksi.
    const m2 = { ...m, text: 'hd', key: { remoteJid: 'chat-tt', id: 'msg2' } }
    assert.equal(await tiktokHandler.before(m2, { conn: fakeConn }), true)
    assert.equal(sentFiles.length, 2)
    assert.ok(!String(sentFiles[1].src).startsWith('http'), 'follow-up hd juga harus dari file lokal')
    assert.equal(sentFiles[1].name, 'tiktok_hd.mp4')
    assert.equal(await tiktokHandler.before(m2, { conn: fakeConn }), false)
    assert.equal(sentFiles.length, 2, 'entri sudah dihapus setelah dipakai')
  } finally { globalThis.fetch = realFetch }
})
