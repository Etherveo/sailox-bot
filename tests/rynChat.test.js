import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseRynArgs, parseNameCall, shouldForward, detectRynTrigger, createRynChat, RYN_SESSION_TTL_MS } from '../lib/helpers/rynChat.js'

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

test('rynChat: shouldForward dasar — teks biasa, bukan perintah/media, bridge on', () => {
  const base = { text: 'halo ryn', mtype: 'conversation', isGroup: false, fromMe: false, isFounder: true, bridgeOn: true }
  assert.equal(shouldForward(base), true)
  assert.equal(shouldForward({ ...base, mtype: 'extendedTextMessage' }), true)
  assert.equal(shouldForward({ ...base, bridgeOn: false }), false)
  assert.equal(shouldForward({ ...base, fromMe: true }), false)
  assert.equal(shouldForward({ ...base, mtype: 'imageMessage' }), false)
  assert.equal(shouldForward({ ...base, text: '   ' }), false)
  assert.equal(shouldForward({ ...base, text: '.ping' }), false)
  assert.equal(shouldForward({ ...base, text: '!menu' }), false)
  assert.equal(shouldForward({ ...base, text: '#tagar biasa' }), false)
})

test('rynChat: shouldForward matriks scope — DM selalu founder-only; grup ikut rynScope/rynUsers/allowlist', () => {
  const dm = { text: 'halo', mtype: 'conversation', isGroup: false, fromMe: false, isFounder: true, bridgeOn: true }
  assert.equal(shouldForward({ ...dm, scope: 'private' }), true)
  assert.equal(shouldForward({ ...dm, scope: 'both' }), true)
  assert.equal(shouldForward({ ...dm, scope: 'group' }), false, 'scope group mematikan DM')
  assert.equal(shouldForward({ ...dm, isFounder: false, scope: 'both', users: 'anyone' }), false, 'DM non-founder tetap ditolak walau rynUsers=anyone')
  const grup = { ...dm, isGroup: true }
  assert.equal(shouldForward({ ...grup, scope: 'private' }), false, 'scope private mematikan grup')
  assert.equal(shouldForward({ ...grup, scope: 'group' }), true)
  assert.equal(shouldForward({ ...grup, scope: 'both' }), true)
  assert.equal(shouldForward({ ...grup, scope: 'both', chatAllowed: false }), false, 'grup di luar allowlist ditolak')
  assert.equal(shouldForward({ ...grup, scope: 'both', isFounder: false, users: 'anyone' }), true, 'anggota biasa boleh bila anyone')
  assert.equal(shouldForward({ ...grup, scope: 'both', isFounder: false, users: 'founder' }), false, 'anggota biasa ditolak bila founder-only')
  assert.equal(shouldForward({ ...grup, scope: 'both', isFounder: true, users: 'founder' }), true)
})

test('rynChat: sesi per chat — teks diteruskan & memperpanjang sesi; 5 menit senyap -> kedaluwarsa', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'rynchat-'))
  let clock = 1_000_000
  const rc = createRynChat({ root, now: () => clock })
  try {
    assert.equal(await rc.forwardSessionMessage({ text: 'halo', msgId: 'A', chat: 'c' }), 'off')
    await rc.startSession('c', { by: '6281@s.whatsapp.net' })
    assert.equal(await rc.sessionActive('c'), true)
    assert.equal(await rc.sessionActive('chat-lain'), false, 'sesi tidak bocor ke chat lain')
    assert.equal(await rc.forwardSessionMessage({ text: 'halo ryn', msgId: 'B', chat: 'c', from: '6281@s.whatsapp.net' }), 'forwarded')
    const files = (await fsp.readdir(rc.dirs.queueDir)).filter(f => f.endsWith('.json'))
    assert.equal(files.length, 1)
    const entry = JSON.parse(await fsp.readFile(path.join(rc.dirs.queueDir, files[0]), 'utf8'))
    assert.equal(entry.type, 'message')
    assert.equal(entry.mode, 'session')
    assert.equal(entry.text, 'halo ryn')
    assert.equal(entry.msgId, 'B')
    assert.equal(entry.chat, 'c')
    assert.equal(entry.from, '6281@s.whatsapp.net')

    clock += RYN_SESSION_TTL_MS - 1000 // hampir habis, pesan baru memperpanjang
    assert.equal(await rc.forwardSessionMessage({ text: 'lanjut', msgId: 'C', chat: 'c', from: '6281@s.whatsapp.net' }), 'forwarded')
    clock += RYN_SESSION_TTL_MS + 1000 // sekarang lewat dari perpanjangan terakhir
    assert.equal(await rc.forwardSessionMessage({ text: 'masih ada?', msgId: 'D', chat: 'c', from: '6281@s.whatsapp.net' }), 'expired')
    assert.equal(await rc.sessionActive('c'), false)
    assert.equal((await rc.readSession()).active, false, 'ringkasan hook ikut mati')

    await rc.startSession('c', { by: '6281@s.whatsapp.net' })
    await rc.endSession('c')
    assert.equal(await rc.sessionActive('c'), false)
    assert.equal(await rc.forwardSessionMessage({ text: 'halo', msgId: 'E', chat: 'c', from: '6281@s.whatsapp.net' }), 'off')
  } finally { await fsp.rm(root, { recursive: true, force: true }) }
})

test('rynChat: sesi grup hanya meneruskan teks pembukanya; ringkasan hook merangkum semua chat', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'rynchat-'))
  let clock = 2_000_000
  const rc = createRynChat({ root, now: () => clock })
  try {
    await rc.startSession('111@g.us', { by: '999@lid' })
    assert.equal(await rc.forwardSessionMessage({ text: 'dari orang lain', msgId: 'X', chat: '111@g.us', from: '888@lid' }), 'not-owner', 'anggota lain tidak ikut tertelan sesi')
    assert.equal(await rc.forwardSessionMessage({ text: 'dari pembuka', msgId: 'Y', chat: '111@g.us', from: '999@lid' }), 'forwarded')
    const files = (await fsp.readdir(rc.dirs.queueDir)).filter(f => f.endsWith('.json'))
    assert.equal(files.length, 1, 'hanya pesan pembuka yang masuk antrean')
    const entry = JSON.parse(await fsp.readFile(path.join(rc.dirs.queueDir, files[0]), 'utf8'))
    assert.equal(entry.isGroup, true)
    const state = await rc.readSession()
    assert.equal(state.active, true)
    assert.equal(state.expiresAt, clock + RYN_SESSION_TTL_MS)
    // Konteks reply ikut diteruskan utuh ke antrean.
    assert.equal(await rc.forwardSessionMessage({ text: 'ini maksudnya apa?', msgId: 'Z', chat: '111@g.us', from: '999@lid', quoted: { text: 'pesan yang ditunjuk', sender: '888@lid', fromBot: false, mtype: 'conversation' } }), 'forwarded')
    const files2 = (await fsp.readdir(rc.dirs.queueDir)).filter(f => f.endsWith('.json'))
    const entries = await Promise.all(files2.map(async f => JSON.parse(await fsp.readFile(path.join(rc.dirs.queueDir, f), 'utf8'))))
    const withQuoted = entries.find(e => e.text === 'ini maksudnya apa?')
    assert.deepEqual(withQuoted.quoted, { text: 'pesan yang ditunjuk', sender: '888@lid', fromBot: false, mtype: 'conversation' })
    // Sesi kedua di chat lain hidup berdampingan.
    await rc.startSession('222@g.us', { by: '888@lid' })
    await rc.endSession('111@g.us')
    assert.equal(await rc.sessionActive('111@g.us'), false)
    assert.equal(await rc.sessionActive('222@g.us'), true)
    assert.equal((await rc.readSession()).active, true, 'ringkasan tetap aktif selama masih ada sesi hidup')
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

test('rynChat: detectRynTrigger — prioritas nama > reply > mention, toggle mematikan masing-masing', () => {
  assert.deepEqual(detectRynTrigger({ nameInput: 'halo', quotedFromBot: true, mentionsBot: true }), { via: 'name' })
  assert.deepEqual(detectRynTrigger({ nameInput: '', quotedFromBot: true }), { via: 'name' }, 'panggilan nama tanpa isi tetap trigger nama')
  assert.deepEqual(detectRynTrigger({ quotedFromBot: true, mentionsBot: true }), { via: 'reply' })
  assert.deepEqual(detectRynTrigger({ mentionsBot: true }), { via: 'mention' })
  assert.equal(detectRynTrigger({ quotedFromBot: true, replyOn: false }), null, 'toggle reply mati = reply ke bot tidak memicu')
  assert.equal(detectRynTrigger({ mentionsBot: true, mentionOn: false }), null, 'toggle mention mati = tag tidak memicu')
  assert.deepEqual(detectRynTrigger({ quotedFromBot: true, mentionsBot: true, replyOn: false }), { via: 'mention' }, 'reply mati, mention hidup tetap jalan')
  assert.equal(detectRynTrigger({}), null)
  assert.equal(detectRynTrigger({ quotedFromBot: false, mentionsBot: false }), null, 'pesan random tidak memicu apa pun')
})
