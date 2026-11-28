import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  validateJob, buildSyntheticMessage, createLocalBridge,
  authorizeBridgeGroup, founderIdentities, isValidGroupJid,
  readGroupAuths, findGroupAuth, appendGroupAuth, consumeGroupAuth, revokeGroupAuth,
  BRIDGE_GROUP_AUTH_TTL_MS,
} from '../lib/helpers/localBridge.js'

const OWNER_PN = '6282348181097'
const OWNER_LID = '147368951459939'
const OWNER = `${OWNER_PN}@s.whatsapp.net`
const OWNER_LID_JID = `${OWNER_LID}@lid`
const GROUP = '120363408674023894@g.us'
const CMD = '.poll Ibu kota Indonesia? | Jakarta | Bandung | Surabaya'
const NOW = Date.parse('2026-11-28T04:55:00Z')
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(file, ms = 15000) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (fs.existsSync(file)) return true; await sleep(50) }
  return false
}
const goodAuth = (over = {}) => ({
  id: 'auth-1', chat: GROUP, command: CMD, authorizedBy: 'founder',
  source: 'ryn-chat', authorizedAt: NOW, expiresAt: NOW + BRIDGE_GROUP_AUTH_TTL_MS, used: false, ...over,
})
const goodGate = (over = {}) => ({
  sender: OWNER, chat: GROUP, command: CMD, auth: goodAuth(),
  founderPn: OWNER_PN, founderLid: OWNER_LID, nowMs: NOW, ...over,
})

// --- Gate deterministik: m.sender + m.chat SEBELUM pesan diproses ---

test('bridge grup: gate lolos bila m.sender founder (PN), m.chat grup sah, otorisasi cocok', () => {
  assert.deepEqual(authorizeBridgeGroup(goodGate()), { ok: true, authId: 'auth-1' })
})

test('bridge grup: gate lolos bila m.sender bentuk LID founder atau PN bersuffix device', () => {
  assert.equal(authorizeBridgeGroup(goodGate({ sender: OWNER_LID_JID })).ok, true)
  assert.equal(authorizeBridgeGroup(goodGate({ sender: `${OWNER_PN}:15@s.whatsapp.net` })).ok, true)
})

test('bridge grup: gate deterministik — input sama selalu hasil sama', () => {
  assert.deepEqual(authorizeBridgeGroup(goodGate()), authorizeBridgeGroup(goodGate()))
  assert.deepEqual(authorizeBridgeGroup(goodGate({ sender: '6281@s.whatsapp.net' })), authorizeBridgeGroup(goodGate({ sender: '6281@s.whatsapp.net' })))
})

test('bridge grup: gate menolak bila JID atau LID founder di config tidak valid', () => {
  assert.match(authorizeBridgeGroup(goodGate({ founderPn: '' })).reason, /PN/)
  assert.match(authorizeBridgeGroup(goodGate({ founderPn: 'abc' })).reason, /PN/)
  assert.match(authorizeBridgeGroup(goodGate({ founderLid: '' })).reason, /LID/)
  assert.match(authorizeBridgeGroup(goodGate({ founderLid: null })).reason, /LID/)
  assert.match(authorizeBridgeGroup(goodGate({ founderLid: 'xyz' })).reason, /LID/)
})

test('bridge grup: gate menolak bila m.sender bukan founder', () => {
  for (const sender of ['6289528749986@s.whatsapp.net', '244078780395660@lid', 'bukan-jid', '', GROUP, null]) {
    assert.equal(authorizeBridgeGroup(goodGate({ sender })).ok, false, `sender ${sender}`)
  }
})

test('bridge grup: gate menolak bila m.chat bukan JID grup', () => {
  for (const chat of [OWNER, OWNER_LID_JID, 'bukan-jid', '123@g.us ', '', null, `${OWNER_PN}:2@s.whatsapp.net`]) {
    assert.equal(authorizeBridgeGroup(goodGate({ chat })).ok, false, `chat ${chat}`)
  }
})

test('bridge grup: gate menolak tanpa otorisasi / otorisasi dipakai / kedaluwarsa / salah grup / salah perintah / bukan founder', () => {
  assert.match(authorizeBridgeGroup(goodGate({ auth: null })).reason, /otorisasi/)
  assert.match(authorizeBridgeGroup(goodGate({ auth: goodAuth({ used: true }) })).reason, /dipakai/)
  assert.match(authorizeBridgeGroup(goodGate({ auth: goodAuth({ expiresAt: NOW }) })).reason, /kedaluwarsa/)
  assert.match(authorizeBridgeGroup(goodGate({ auth: goodAuth({ chat: '120363999999999999@g.us' }) })).reason, /grup ini/)
  assert.match(authorizeBridgeGroup(goodGate({ auth: goodAuth({ command: '.ping' }) })).reason, /perintah ini/)
  assert.match(authorizeBridgeGroup(goodGate({ auth: goodAuth({ authorizedBy: 'orang-lain' }) })).reason, /founder/)
  // Spasi di ujung perintah ditoleransi (trim), isinya harus persis sama.
  assert.equal(authorizeBridgeGroup(goodGate({ auth: goodAuth({ command: ` ${CMD} ` }) })).ok, true)
})

test('bridge grup: isValidGroupJid + founderIdentities', () => {
  assert.equal(isValidGroupJid(GROUP), true)
  assert.equal(isValidGroupJid(OWNER), false)
  assert.equal(isValidGroupJid('bukan-jid'), false)
  assert.equal(isValidGroupJid(''), false)
  assert.equal(isValidGroupJid(null), false)
  assert.deepEqual(founderIdentities({ founder: [[OWNER_PN, OWNER_LID, 'Veo']] }), { pn: OWNER_PN, lid: OWNER_LID })
  assert.deepEqual(founderIdentities({ founder: [[OWNER_PN, '', 'Veo']] }), { pn: OWNER_PN, lid: null })
  assert.deepEqual(founderIdentities({ founder: [] }), { pn: null, lid: null })
  assert.deepEqual(founderIdentities({}), { pn: null, lid: null })
})

// --- validateJob + buildSyntheticMessage ---

test('bridge grup: validateJob menerima chat grup hanya untuk cmd; say/file/reply menolak', () => {
  assert.deepEqual(validateJob({ type: 'cmd', text: CMD, chat: GROUP }), { type: 'cmd', text: CMD, chat: GROUP })
  assert.throws(() => validateJob({ type: 'cmd', text: '.ping', chat: OWNER }), /grup/)
  assert.throws(() => validateJob({ type: 'cmd', text: '.ping', chat: 'bukan-jid' }), /grup/)
  assert.throws(() => validateJob({ type: 'say', text: 'halo', chat: GROUP }), /hanya untuk job cmd/)
  assert.throws(() => validateJob({ type: 'file', path: 'a.txt', chat: GROUP }), /hanya untuk job cmd/)
  assert.throws(() => validateJob({ type: 'reply', ref: 'ok', text: 'x', chat: GROUP }), /hanya untuk job cmd/)
  // Field 'to' lama tetap diabaikan (perilaku lama, dipin tes lama).
  assert.deepEqual(validateJob({ type: 'cmd', text: '.ping', to: '6289999999999@s.whatsapp.net' }), { type: 'cmd', text: '.ping' })
})

test('bridge grup: buildSyntheticMessage grup membawa remoteJid grup + participant founder', () => {
  const msg = buildSyntheticMessage({ ownerJid: OWNER, text: CMD, chat: GROUP, participant: OWNER, id: 'RYN1' })
  assert.equal(msg.key.remoteJid, GROUP)
  assert.equal(msg.key.participant, OWNER)
  assert.equal(msg.key.fromMe, false)
  assert.equal(msg.message.conversation, CMD)
  const dm = buildSyntheticMessage({ ownerJid: OWNER, text: '.ping', id: 'RYN2' })
  assert.equal(dm.key.remoteJid, OWNER)
  assert.equal(dm.key.participant, undefined)
})

// --- Penyimpanan otorisasi ---

test('bridge grup: otorisasi sekali pakai — append, cari, konsumsi, cabut', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-auth-'))
  try {
    const dir = path.join(root, 'bridge')
    await fsp.mkdir(dir, { recursive: true })
    assert.deepEqual(await readGroupAuths(dir), [])
    const auth = await appendGroupAuth(dir, { chat: GROUP, command: CMD, nowMs: NOW })
    assert.equal(auth.authorizedBy, 'founder')
    assert.equal(auth.expiresAt - auth.authorizedAt, BRIDGE_GROUP_AUTH_TTL_MS)
    assert.ok(findGroupAuth(await readGroupAuths(dir), { chat: GROUP, command: CMD, nowMs: NOW }))
    assert.equal(findGroupAuth(await readGroupAuths(dir), { chat: GROUP, command: '.ping', nowMs: NOW }), null)
    assert.equal(findGroupAuth(await readGroupAuths(dir), { chat: GROUP, command: CMD, nowMs: NOW + BRIDGE_GROUP_AUTH_TTL_MS }), null)
    assert.equal(await consumeGroupAuth(dir, auth.id), true)
    assert.equal(await consumeGroupAuth(dir, auth.id), false, 'konsumsi kedua gagal — sekali pakai')
    assert.equal(findGroupAuth(await readGroupAuths(dir), { chat: GROUP, command: CMD, nowMs: NOW }), null)
    const auth2 = await appendGroupAuth(dir, { chat: GROUP, command: '.ping', nowMs: NOW })
    assert.equal(await revokeGroupAuth(dir, auth2.id), true)
    assert.equal(findGroupAuth(await readGroupAuths(dir), { chat: GROUP, command: '.ping', nowMs: NOW }), null)
    await assert.rejects(() => appendGroupAuth(dir, { chat: OWNER, command: CMD }), /grup/)
    await assert.rejects(() => appendGroupAuth(dir, { chat: GROUP, command: '  ' }), /command/)
    await assert.rejects(() => appendGroupAuth(dir, { chat: GROUP, command: CMD, source: 'entah' }), /source/)
  } finally { await fsp.rm(root, { recursive: true, force: true }) }
})

// --- Alur runJob cmd grup (fake socket, tanpa koneksi WA) ---

test('bridge grup: cmd grup tanpa otorisasi ditolak gate — pipeline TIDAK dipanggil, tidak ada kiriman ke grup', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-'))
  const sent = []
  let handlerCalls = 0
  const conn = {
    sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { id: 'srv' } } },
    pipeline: { handler: async () => { handlerCalls++ } },
  }
  const bridge = createLocalBridge({ root, getConn: () => conn, isOpen: () => true, config: { bridge: true, founder: [[OWNER_PN, OWNER_LID]] }, pollMs: 25 })
  await bridge.start()
  try {
    await fsp.writeFile(path.join(bridge.dirs.inboxDir, 'jobGrpNoAuth.json'), JSON.stringify({ type: 'cmd', text: CMD, chat: GROUP }))
    assert.ok(await waitFor(path.join(bridge.dirs.outboxDir, 'jobGrpNoAuth.json')), 'hasil muncul')
    const result = JSON.parse(await fsp.readFile(path.join(bridge.dirs.outboxDir, 'jobGrpNoAuth.json'), 'utf8'))
    assert.equal(result.ok, false)
    assert.match(result.error, /gate.*otorisasi/)
    assert.equal(handlerCalls, 0, 'pipeline tidak boleh dipanggil')
    assert.equal(sent.some(s => s.jid === GROUP), false, 'tidak ada kiriman ke grup')
  } finally { bridge.stop(); await fsp.rm(root, { recursive: true, force: true }) }
})

test('bridge grup: cmd grup dengan otorisasi masuk pipeline sebagai pesan founder di grup; otorisasi hangus; balasan grup tertangkap', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-'))
  const sent = []
  let seenUpdate = null
  const conn = {
    sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { id: 'srv' } } },
    pipeline: {
      handler: async function (update) {
        seenUpdate = update
        await this.sendMessage(GROUP, { text: 'balasan plugin di grup' })
      },
    },
  }
  const config = { bridge: true, founder: [[OWNER_PN, OWNER_LID]] }
  const bridge = createLocalBridge({ root, getConn: () => conn, isOpen: () => true, config, pollMs: 25 })
  await bridge.start()
  try {
    const bridgeDir = path.join(root, 'src', 'private', 'bridge')
    const auth = await appendGroupAuth(bridgeDir, { chat: GROUP, command: CMD })
    await fsp.writeFile(path.join(bridge.dirs.inboxDir, 'jobGrpOk.json'), JSON.stringify({ type: 'cmd', text: CMD, chat: GROUP }))
    assert.ok(await waitFor(path.join(bridge.dirs.outboxDir, 'jobGrpOk.json')), 'hasil muncul')
    const result = JSON.parse(await fsp.readFile(path.join(bridge.dirs.outboxDir, 'jobGrpOk.json'), 'utf8'))
    assert.equal(result.ok, true)
    assert.equal(result.chat, GROUP)
    assert.equal(seenUpdate.type, 'notify')
    assert.equal(seenUpdate.messages[0].key.remoteJid, GROUP, 'm.chat = grup')
    assert.equal(seenUpdate.messages[0].key.participant, OWNER, 'm.sender = founder')
    assert.equal(seenUpdate.messages[0].key.fromMe, false)
    assert.equal(seenUpdate.messages[0].message.conversation, CMD)
    assert.ok(sent.some(s => s.jid === OWNER && s.content.text.startsWith(`🧪 [tes Ryn → ${GROUP}]`)), 'penanda tes ke DM owner menyebut grup')
    assert.ok(result.replies.some(r => r.chat === GROUP && r.text === 'balasan plugin di grup'), 'balasan ke grup tertangkap di outbox')
    assert.equal(findGroupAuth(await readGroupAuths(bridgeDir), { chat: GROUP, command: CMD }), null, 'otorisasi hangus setelah dipakai')
    assert.equal((await readGroupAuths(bridgeDir)).find(a => a.id === auth.id)?.used, true)
    // Pakai ulang perintah yang sama (tanpa otorisasi baru) harus ditolak.
    await fsp.writeFile(path.join(bridge.dirs.inboxDir, 'jobGrpUlang.json'), JSON.stringify({ type: 'cmd', text: CMD, chat: GROUP }))
    assert.ok(await waitFor(path.join(bridge.dirs.outboxDir, 'jobGrpUlang.json')), 'hasil kedua muncul')
    const ulang = JSON.parse(await fsp.readFile(path.join(bridge.dirs.outboxDir, 'jobGrpUlang.json'), 'utf8'))
    assert.equal(ulang.ok, false)
    assert.match(ulang.error, /gate/)
  } finally { bridge.stop(); await fsp.rm(root, { recursive: true, force: true }) }
})

test('bridge grup: cmd grup dengan otorisasi tetap ditolak bila LID founder kosong di config', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-'))
  let handlerCalls = 0
  const conn = {
    sendMessage: async () => ({ key: { id: 'srv' } }),
    pipeline: { handler: async () => { handlerCalls++ } },
  }
  const bridge = createLocalBridge({ root, getConn: () => conn, isOpen: () => true, config: { bridge: true, founder: [[OWNER_PN, '']] }, pollMs: 25 })
  await bridge.start()
  try {
    const bridgeDir = path.join(root, 'src', 'private', 'bridge')
    await appendGroupAuth(bridgeDir, { chat: GROUP, command: CMD })
    await fsp.writeFile(path.join(bridge.dirs.inboxDir, 'jobGrpNoLid.json'), JSON.stringify({ type: 'cmd', text: CMD, chat: GROUP }))
    assert.ok(await waitFor(path.join(bridge.dirs.outboxDir, 'jobGrpNoLid.json')), 'hasil muncul')
    const result = JSON.parse(await fsp.readFile(path.join(bridge.dirs.outboxDir, 'jobGrpNoLid.json'), 'utf8'))
    assert.equal(result.ok, false)
    assert.match(result.error, /LID/)
    assert.equal(handlerCalls, 0)
  } finally { bridge.stop(); await fsp.rm(root, { recursive: true, force: true }) }
})
