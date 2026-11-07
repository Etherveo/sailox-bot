import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { isConnectionSendError, waitForConnectionOpen } from '../lib/helpers/sendRetry.js'

// ─── isConnectionSendError ───────────────────────────────────────────────────

test('sendRetry: error kelas koneksi dikenali', () => {
  assert.equal(isConnectionSendError(new Error('Connection Closed')), true)
  assert.equal(isConnectionSendError(new Error('Connection was lost')), true)
  assert.equal(isConnectionSendError(new Error('Koneksi belum terbuka')), true)
  assert.equal(isConnectionSendError(new Error('socket hang up')), true)
  assert.equal(isConnectionSendError(new Error('Request timed out')), true)
  assert.equal(isConnectionSendError(Object.assign(new Error('boom'), { output: { statusCode: 428 } })), true)
  assert.equal(isConnectionSendError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true)
})

test('sendRetry: error non-koneksi TIDAK dikenali sebagai kelas koneksi', () => {
  assert.equal(isConnectionSendError(new Error('File terlalu besar')), false)
  assert.equal(isConnectionSendError(new Error('Gagal mengambil informasi file Pixeldrain: HTTP 451 dari pixeldrain.com')), false)
  assert.equal(isConnectionSendError(new Error('media ditolak server WA')), false)
  assert.equal(isConnectionSendError(null), false)
  assert.equal(isConnectionSendError(undefined), false)
})

// ─── waitForConnectionOpen ───────────────────────────────────────────────────

test('sendRetry: ws sudah terbuka -> langsung true', async () => {
  const conn = { ws: { readyState: 1 } }
  assert.equal(await waitForConnectionOpen(conn, 50), true)
})

test('sendRetry: event connection.update open -> true', async () => {
  const ev = new EventEmitter()
  const conn = { ev, ws: { readyState: 3 } }
  const p = waitForConnectionOpen(conn, 5_000)
  setTimeout(() => ev.emit('connection.update', { connection: 'open' }), 20)
  assert.equal(await p, true)
  assert.equal(ev.listenerCount('connection.update'), 0, 'listener dibersihkan sesudah selesai')
})

test('sendRetry: koneksi tidak pulih sampai batas waktu -> false', async () => {
  const ev = new EventEmitter()
  const conn = { ev, ws: { readyState: 3 } }
  assert.equal(await waitForConnectionOpen(conn, 60), false)
  assert.equal(ev.listenerCount('connection.update'), 0, 'listener dibersihkan sesudah timeout')
})

test('sendRetry: tanpa sumber event -> jeda singkat lalu true (percobaan kirim yang membuktikan)', async () => {
  const conn = {}
  assert.equal(await waitForConnectionOpen(conn, 40), true)
})

test('sendRetry: tanpa conn -> false', async () => {
  assert.equal(await waitForConnectionOpen(null, 10), false)
})
