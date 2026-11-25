// tests/store.test.js — cache metadata grup (lib/store.js): TTL,
// invalidasi lewat event, refresh paksa (throttle), dan invalidateGroups.
// Menguji perbaikan deteksi admin real-time (insiden KDN 2026-11-26):
// promosi bot yang kelewat event saat reconnect tidak boleh membuat
// isBotAdmin basi.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createStore } from '../lib/store.js'

const GROUP = '123456789@g.us'
const BOT = '20002@lid'
const staleMeta = { id: GROUP, subject: 'Test group', participants: [{ id: '10001@lid', admin: 'admin' }, { id: BOT, admin: null }] }
const freshMeta = { id: GROUP, subject: 'Test group', participants: [{ id: '10001@lid', admin: 'admin' }, { id: BOT, admin: 'admin' }] }

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, { tries = 200, gap = 5 } = {}) {
  for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await sleep(gap) }
  throw new Error('timeout menunggu kondisi')
}

function setup() {
  let nowMs = Date.now()
  let meta = staleMeta
  let fetches = 0
  const sock = {
    ev: new EventEmitter(),
    async groupMetadata(id) { fetches++; return meta },
  }
  const store = createStore({ now: () => nowMs, wait: async () => {} })
  store.bind(sock)
  return {
    store, sock,
    fetches: () => fetches,
    setMeta: m => { meta = m },
    advance: ms => { nowMs += ms },
    close: async () => { await store.close() },
  }
}

test('getGroupMetadata: cache dipakai, fetch kedua tidak memanggil server', async t => {
  const s = setup()
  t.after(() => s.close())
  const first = await s.store.getGroupMetadata(GROUP)
  const second = await s.store.getGroupMetadata(GROUP)
  assert.equal(first, second, 'hasil kedua dari cache (objek sama)')
  assert.equal(s.fetches(), 1)
})

test('group-participants.update: cache dihapus lalu di-refetch dari server', async t => {
  const s = setup()
  t.after(() => s.close())
  await s.store.getGroupMetadata(GROUP) // prime cache (bot bukan admin)
  assert.equal(s.store.cachedGroupMetadata(GROUP).participants[1].admin, null)
  s.setMeta(freshMeta) // server kini bilang bot admin
  s.sock.ev.emit('group-participants.update', { id: GROUP, participants: [{ id: BOT, action: 'promote' }], action: 'promote' })
  const updated = await until(() => {
    const m = s.store.cachedGroupMetadata(GROUP)
    return m?.participants[1].admin === 'admin' ? m : null
  })
  assert.equal(updated.participants[1].admin, 'admin')
  assert.ok(s.fetches() >= 2, 'refetch latar terjadi')
})

test('refreshGroupMetadata: fetch segar sekali, lalu throttle 60 detik, lalu fetch lagi', async t => {
  const s = setup()
  t.after(() => s.close())
  await s.store.getGroupMetadata(GROUP) // prime (bot bukan admin), fetches = 1
  s.setMeta(freshMeta)
  const fresh = await s.store.refreshGroupMetadata(GROUP)
  assert.equal(fresh.participants[1].admin, 'admin', 'refresh pertama mengambil data segar')
  assert.equal(s.fetches(), 2)
  const cached = await s.store.refreshGroupMetadata(GROUP)
  assert.equal(cached, fresh, 'refresh kedua dalam 60 detik mengembalikan cache tanpa fetch')
  assert.equal(s.fetches(), 2, 'tidak ada fetch kedua')
  s.advance(61000)
  await s.store.refreshGroupMetadata(GROUP)
  assert.equal(s.fetches(), 3, 'setelah 60 detik fetch lagi')
})

test('refreshGroupMetadata: gagal fetch mengembalikan cache lama, bukan throw', async t => {
  const s = setup()
  t.after(() => s.close())
  await s.store.getGroupMetadata(GROUP) // prime
  s.sock.groupMetadata = async () => { throw new Error('server down') }
  const result = await s.store.refreshGroupMetadata(GROUP)
  assert.equal(result.participants[1].admin, null, 'cache lama dikembalikan')
})

test('invalidateGroups: cache dibuang, fetch berikutnya ke server lagi', async t => {
  const s = setup()
  t.after(() => s.close())
  await s.store.getGroupMetadata(GROUP)
  assert.equal(s.fetches(), 1)
  s.store.invalidateGroups()
  assert.equal(s.store.cachedGroupMetadata(GROUP), undefined, 'cache kosong setelah invalidate')
  s.setMeta(freshMeta)
  const m = await s.store.getGroupMetadata(GROUP)
  assert.equal(m.participants[1].admin, 'admin')
  assert.equal(s.fetches(), 2)
})
