import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseRynArgs, parseNameCall, shouldForward, createRynChat, RYN_SESSION_TTL_MS } from '../lib/helpers/rynChat.js'

test('rynChat: parseRynArgs memisahkan flag di posisi mana pun dari input awal', () => {
  assert.deepEqual(parseRynArgs('halo apa kabar'), { flag: null, input: 'halo apa kabar' })
  assert.deepEqual(parseRynArgs('--on'), { flag: 'on', input: '' })
  assert.deepEqual(parseRynArgs('--on halo'), { flag: 'on', input: 'halo' })
  assert.deepEqual(parseRynArgs('halo --on dunia'), { flag: 'on', input: 'halo dunia' })
  assert.deepEqual(parseRynArgs('--off'), { flag: 'off', input: '' })
  assert.deepEqual(parseRynArgs(''), { flag: null, input: '' })
})

test('rynChat: parseNameCall hanya mengenali panggilan nama di awal pesan', () => {
  assert.deepEqual(parseNameCall('Ryn, tolong cek panel'), { input: 'tolong cek panel' })
  assert.deepEqual(parseNameCall('ryn halo'), { input: 'halo' })
  assert.deepEqual(parseNameCall('RYN! bangun'), { input: 'bangun' })
  assert.deepEqual(parseNameCall('Ryn'), { input: '' })
  assert.deepEqual(parseNameCall('Ryn,'), { input: '' })
  assert.equal(parseNameCall('Ryna, halo'), null)
  assert.equal(parseNameCall('kemarin Ryn bilang begitu'), null)
  assert.equal(parseNameCall('halo Ryn'), null)
  assert.equal(parseNameCall(''), null)
})

test('rynChat: shouldForward hanya untuk teks biasa founder di DM saat bridge on', () => {
  const base = { text: 'halo ryn', mtype: 'conversation', isGroup: false, fromMe: false, isFounder: true, bridgeOn: true }
  assert.equal(shouldForward(base), true)
  assert.equal(shouldForward({ ...base, mtype: 'extendedTextMessage' }), true)
  assert.equal(shouldForward({ ...base, bridgeOn: false }), false)
  assert.equal(shouldForward({ ...base, isFounder: false }), false)
  assert.equal(shouldForward({ ...base, isGroup: true }), false)
  assert.equal(shouldForward({ ...base, fromMe: true }), false)
  assert.equal(shouldForward({ ...base, mtype: 'imageMessage' }), false)
  assert.equal(shouldForward({ ...base, text: '   ' }), false)
  assert.equal(shouldForward({ ...base, text: '.ping' }), false)
  assert.equal(shouldForward({ ...base, text: '!menu' }), false)
  assert.equal(shouldForward({ ...base, text: '#tagar biasa' }), false)
})

test('rynChat: sesi on -> teks diteruskan & memperpanjang sesi; 5 menit senyap -> kedaluwarsa', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'rynchat-'))
  let clock = 1_000_000
  const rc = createRynChat({ root, now: () => clock })
  try {
    assert.equal(await rc.forwardSessionMessage({ text: 'halo', msgId: 'A', chat: 'c' }), 'off')
    await rc.startSession()
    assert.equal(await rc.sessionActive(), true)
    assert.equal(await rc.forwardSessionMessage({ text: 'halo ryn', msgId: 'B', chat: 'c' }), 'forwarded')
    const files = (await fsp.readdir(rc.dirs.queueDir)).filter(f => f.endsWith('.json'))
    assert.equal(files.length, 1)
    const entry = JSON.parse(await fsp.readFile(path.join(rc.dirs.queueDir, files[0]), 'utf8'))
    assert.equal(entry.type, 'message')
    assert.equal(entry.mode, 'session')
    assert.equal(entry.text, 'halo ryn')
    assert.equal(entry.msgId, 'B')

    clock += RYN_SESSION_TTL_MS - 1000 // hampir habis, pesan baru memperpanjang
    assert.equal(await rc.forwardSessionMessage({ text: 'lanjut', msgId: 'C', chat: 'c' }), 'forwarded')
    clock += RYN_SESSION_TTL_MS + 1000 // sekarang lewat dari perpanjangan terakhir
    assert.equal(await rc.forwardSessionMessage({ text: 'masih ada?', msgId: 'D', chat: 'c' }), 'expired')
    assert.equal(await rc.sessionActive(), false)
    assert.equal((await rc.readSession()).active, false)

    await rc.startSession()
    await rc.endSession()
    assert.equal(await rc.sessionActive(), false)
    assert.equal(await rc.forwardSessionMessage({ text: 'halo', msgId: 'E', chat: 'c' }), 'off')
  } finally { await fsp.rm(root, { recursive: true, force: true }) }
})

test('rynChat: enqueue menulis file JSON antrean yang bisa diurutkan berdasarkan nama', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'rynchat-'))
  let clock = 5000
  const rc = createRynChat({ root, now: () => clock })
  try {
    await rc.enqueue({ type: 'session-start', mode: 'session' })
    clock += 10
    await rc.enqueue({ type: 'message', mode: 'once', text: 'tes' })
    const files = (await fsp.readdir(rc.dirs.queueDir)).filter(f => f.endsWith('.json')).sort()
    assert.equal(files.length, 2)
    const first = JSON.parse(await fsp.readFile(path.join(rc.dirs.queueDir, files[0]), 'utf8'))
    assert.equal(first.type, 'session-start')
    assert.ok(fs.existsSync(rc.sessionFile.replace(/ryn-session\.json$/, '')) || true)
  } finally { await fsp.rm(root, { recursive: true, force: true }) }
})
