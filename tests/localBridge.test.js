import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateJob, buildSyntheticMessage, summarizeContent, ownerJidOf, createLocalBridge, resolveBridgeFile, BRIDGE_MAX_MEDIA_BYTES, BRIDGE_RETENTION_MS } from '../lib/helpers/localBridge.js'

const OWNER = '6282348181097@s.whatsapp.net'
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(file, ms = 8000) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (fs.existsSync(file)) return true; await sleep(50) }
  return false
}

test('bridge: validateJob menerima say/cmd dan menolak sisanya', () => {
  assert.deepEqual(validateJob({ type: 'say', text: 'halo' }), { type: 'say', text: 'halo' })
  assert.deepEqual(validateJob({ type: 'cmd', text: '.ping' }), { type: 'cmd', text: '.ping' })
  assert.throws(() => validateJob(null), /objek JSON/)
  assert.throws(() => validateJob({ type: 'eval', text: 'x' }), /say.*cmd/)
  assert.throws(() => validateJob({ type: 'say', text: '  ' }), /wajib diisi/)
  assert.throws(() => validateJob({ type: 'say', text: 'x'.repeat(4001) }), /maksimal/)
})

test('bridge: validateJob menerima job file dan menolak yang tidak lengkap', () => {
  assert.deepEqual(validateJob({ type: 'file', path: 'sailox-bot/doc.pdf' }), { type: 'file', path: 'sailox-bot/doc.pdf', caption: '' })
  assert.deepEqual(validateJob({ type: 'file', path: 'a/b.txt', caption: 'halo' }), { type: 'file', path: 'a/b.txt', caption: 'halo' })
  assert.throws(() => validateJob({ type: 'file' }), /path wajib/)
  assert.throws(() => validateJob({ type: 'file', path: '  ' }), /path wajib/)
  assert.throws(() => validateJob({ type: 'teleport', text: 'x' }), /say.*cmd.*file/)
})

test('bridge: resolveBridgeFile mengurung file di workspace dan memblokir rahasia', () => {
  const root = '/home/test/workspace/sailox-bot'
  assert.equal(resolveBridgeFile(root, 'sailox-bot/src/doc.pdf'), '/home/test/workspace/sailox-bot/src/doc.pdf')
  assert.equal(resolveBridgeFile(root, '/home/test/workspace/catatan.txt'), '/home/test/workspace/catatan.txt')
  assert.throws(() => resolveBridgeFile(root, '../di-luar.txt'), /di luar workspace/)
  assert.throws(() => resolveBridgeFile(root, '/etc/passwd'), /di luar workspace/)
  assert.throws(() => resolveBridgeFile(root, 'sailox-bot/sessions/creds.json'), /terlarang/)
  assert.throws(() => resolveBridgeFile(root, 'sailox-bot/gdrive-auth/token.json'), /terlarang/)
  assert.throws(() => resolveBridgeFile(root, 'sailox-bot/.env'), /terlarang/)
  assert.throws(() => resolveBridgeFile(root, 'sailox-panel/.panel-token'), /terlarang/)
  assert.throws(() => resolveBridgeFile(root, 'sailox-bot/kunci.key'), /terlarang/)
})

test('bridge: job file terkirim lewat sendFile ke owner; file hilang jadi hasil error', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-'))
  const sentFiles = []
  const conn = {
    sendMessage: async () => ({}),
    sendFile: async (jid, source, name, caption) => { sentFiles.push({ jid, source, name, caption }); return { key: { id: 'srv' } } },
    pipeline: { handler: async () => {} },
  }
  const bridge = createLocalBridge({ root, getConn: () => conn, isOpen: () => true, config: { bridge: true, founder: [['6282348181097', '']] }, pollMs: 25 })
  await bridge.start()
  try {
    const docPath = path.join(root, 'dokumen.txt')
    await fsp.writeFile(docPath, 'isi dokumen')
    await fsp.writeFile(path.join(bridge.dirs.inboxDir, 'jobFile1.json'), JSON.stringify({ type: 'file', path: docPath, caption: 'nih dok' }))
    assert.ok(await waitFor(path.join(bridge.dirs.outboxDir, 'jobFile1.json')), 'hasil file muncul')
    const res = JSON.parse(await fsp.readFile(path.join(bridge.dirs.outboxDir, 'jobFile1.json'), 'utf8'))
    assert.equal(res.ok, true)
    assert.equal(res.type, 'file')
    assert.equal(res.path, docPath)
    assert.deepEqual(sentFiles, [{ jid: OWNER, source: docPath, name: 'dokumen.txt', caption: 'nih dok' }])

    await fsp.writeFile(path.join(bridge.dirs.inboxDir, 'jobFile2.json'), JSON.stringify({ type: 'file', path: path.join(root, 'tidak-ada.txt') }))
    assert.ok(await waitFor(path.join(bridge.dirs.outboxDir, 'jobFile2.json')), 'hasil file hilang muncul')
    const res2 = JSON.parse(await fsp.readFile(path.join(bridge.dirs.outboxDir, 'jobFile2.json'), 'utf8'))
    assert.equal(res2.ok, false)
    assert.match(res2.error, /tidak ditemukan/)
  } finally { bridge.stop(); await fsp.rm(root, { recursive: true, force: true }) }
})

test('bridge: ownerJidOf hanya dari config founder', () => {
  assert.equal(ownerJidOf({ founder: [['6282348181097', '123']] }), OWNER)
  assert.equal(ownerJidOf({ founder: [] }), null)
  assert.equal(ownerJidOf({}), null)
})

test('bridge: pesan sintetis berbentuk seperti pesan owner di room owner', () => {
  const raw = buildSyntheticMessage({ ownerJid: OWNER, text: '.ping', nowMs: 1700000000500, id: 'RYNABC' })
  assert.equal(raw.key.remoteJid, OWNER)
  assert.equal(raw.key.fromMe, false)
  assert.equal(raw.key.id, 'RYNABC')
  assert.equal(raw.message.conversation, '.ping')
  assert.equal(raw.messageTimestamp, 1700000000)
})

test('bridge: summarizeContent memilah teks, reaksi, dan media', async () => {
  assert.deepEqual(await summarizeContent({ text: 'halo' }), { kind: 'text', text: 'halo' })
  assert.deepEqual(await summarizeContent({ react: { text: '👍', key: {} } }), { kind: 'react', emoji: '👍' })
  const saved = []
  const entry = await summarizeContent({ sticker: Buffer.from('webp!'), mimetype: 'image/webp' }, async (kind, buf, mime) => { saved.push([kind, buf.length, mime]); return 'job-1.webp' })
  assert.equal(entry.kind, 'sticker')
  assert.equal(entry.file, 'job-1.webp')
  assert.equal(entry.bytes, 5)
  assert.deepEqual(saved, [['sticker', 5, 'image/webp']])
  const noSave = await summarizeContent({ image: Buffer.from('jpg'), caption: 'cap' })
  assert.equal(noSave.kind, 'image')
  assert.equal(noSave.file, undefined)
  assert.equal(noSave.caption, 'cap')
})

test('bridge: media besar hanya metadata di outbox, media kecil disimpan sebagai file', async () => {
  let saveCalls = 0
  const saveMedia = async () => { saveCalls++; return 'job-x.bin' }
  const big = await summarizeContent({ video: Buffer.alloc(BRIDGE_MAX_MEDIA_BYTES + 1), mimetype: 'video/mp4', fileName: 'film.mp4' }, saveMedia)
  assert.equal(big.kind, 'video')
  assert.equal(big.bytes, BRIDGE_MAX_MEDIA_BYTES + 1)
  assert.equal(big.mimetype, 'video/mp4')
  assert.equal(big.ext, 'mp4')
  assert.equal(big.fileName, 'film.mp4')
  assert.equal(big.file, undefined)
  assert.equal(big.fileOmitted, 'too-large')
  assert.equal(saveCalls, 0)
  const small = await summarizeContent({ image: Buffer.from('jpg'), mimetype: 'image/jpeg' }, saveMedia)
  assert.equal(small.file, 'job-x.bin')
  assert.equal(small.fileOmitted, undefined)
  assert.equal(saveCalls, 1)
})

test('bridge: cleanup menghapus hasil outbox kedaluwarsa beserta medianya, yang segar bertahan', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-'))
  const conn = { sendMessage: async () => ({}), pipeline: { handler: async () => {} } }
  const bridge = createLocalBridge({ root, getConn: () => conn, isOpen: () => true, config: { bridge: true, founder: [['6282348181097', '']] }, pollMs: 25 })
  await bridge.start()
  try {
    const oldJson = path.join(bridge.dirs.outboxDir, 'jobOld1.json')
    const oldMedia = path.join(bridge.dirs.outboxDir, 'jobOld1-1.webp')
    const freshJson = path.join(bridge.dirs.outboxDir, 'jobNew1.json')
    await fsp.writeFile(oldJson, '{}')
    await fsp.writeFile(oldMedia, 'webp')
    await fsp.writeFile(freshJson, '{}')
    const old = new Date(Date.now() - BRIDGE_RETENTION_MS - 60000)
    await fsp.utimes(oldJson, old, old)
    await fsp.utimes(oldMedia, old, old)
    await bridge.cleanupNow()
    assert.equal(fs.existsSync(oldJson), false)
    assert.equal(fs.existsSync(oldMedia), false)
    assert.equal(fs.existsSync(freshJson), true)
  } finally { bridge.stop(); await fsp.rm(root, { recursive: true, force: true }) }
})

test('bridge: job say terkirim ke owner dan tercatat; cmd masuk pipeline dan balasannya tertangkap', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-'))
  const sent = []
  let seenUpdate = null
  const conn = {
    sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { id: 'srv' } } },
    pipeline: {
      handler: async function (update) {
        seenUpdate = update
        // Balasan plugin di bot asli dialamatkan ke bentuk LID owner, bukan PN.
        await this.sendMessage('1234567890@lid', { text: 'pong!' })
      },
    },
  }
  const bridge = createLocalBridge({ root, getConn: () => conn, isOpen: () => true, config: { bridge: true, founder: [['6282348181097', '1234567890']] }, pollMs: 25 })
  await bridge.start()
  try {
    await fsp.writeFile(path.join(bridge.dirs.inboxDir, 'jobSay1.json'), JSON.stringify({ type: 'say', text: 'halo Veo' }))
    assert.ok(await waitFor(path.join(bridge.dirs.outboxDir, 'jobSay1.json')), 'hasil say muncul')
    const sayResult = JSON.parse(await fsp.readFile(path.join(bridge.dirs.outboxDir, 'jobSay1.json'), 'utf8'))
    assert.equal(sayResult.ok, true)
    assert.equal(sent[0].jid, OWNER)
    assert.equal(sent[0].content.text, 'halo Veo')
    assert.equal(sayResult.replies[0].text, 'halo Veo')
    assert.equal(sayResult.replies[0].chat, OWNER)
    assert.equal(fs.existsSync(path.join(bridge.dirs.inboxDir, 'jobSay1.json')), false)

    await fsp.writeFile(path.join(bridge.dirs.inboxDir, 'jobCmd1.json'), JSON.stringify({ type: 'cmd', text: '.ping', to: '6289999999999@s.whatsapp.net' }))
    assert.ok(await waitFor(path.join(bridge.dirs.outboxDir, 'jobCmd1.json'), 15000), 'hasil cmd muncul')
    const cmdResult = JSON.parse(await fsp.readFile(path.join(bridge.dirs.outboxDir, 'jobCmd1.json'), 'utf8'))
    assert.equal(cmdResult.ok, true)
    assert.equal(seenUpdate.type, 'notify')
    assert.equal(seenUpdate.messages[0].key.remoteJid, OWNER)
    assert.equal(seenUpdate.messages[0].key.fromMe, false)
    assert.equal(seenUpdate.messages[0].message.conversation, '.ping')
    assert.ok(sent.every(s => s.jid === OWNER || s.jid === '1234567890@lid'), 'semua kiriman hanya ke owner (PN atau LID)')
    assert.ok(cmdResult.replies.some(r => r.text?.startsWith('🧪 [tes Ryn]')), 'penanda tes tercatat')
    assert.ok(cmdResult.replies.some(r => r.text === 'pong!'), 'balasan plugin tertangkap')
  } finally { bridge.stop(); await fsp.rm(root, { recursive: true, force: true }) }
})

test('bridge: saklar mati = job tidak disentuh; job rusak = hasil error', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-'))
  const conn = { sendMessage: async () => { throw new Error('tidak boleh terpanggil') }, pipeline: { handler: async () => {} } }
  const off = createLocalBridge({ root, getConn: () => conn, isOpen: () => true, config: { bridge: false, founder: [['6282348181097', '']] }, pollMs: 25 })
  await off.start()
  try {
    await fsp.writeFile(path.join(off.dirs.inboxDir, 'jobOff1.json'), JSON.stringify({ type: 'say', text: 'halo' }))
    await sleep(300)
    assert.equal(fs.existsSync(path.join(off.dirs.inboxDir, 'jobOff1.json')), true)
    assert.equal(fs.existsSync(path.join(off.dirs.outboxDir, 'jobOff1.json')), false)
  } finally { off.stop() }

  const on = createLocalBridge({ root, getConn: () => conn, isOpen: () => true, config: { bridge: true, founder: [['6282348181097', '']] }, pollMs: 25 })
  await on.start()
  try {
    await fsp.writeFile(path.join(on.dirs.inboxDir, 'jobBad1.json'), '{bukan json')
    assert.ok(await waitFor(path.join(on.dirs.outboxDir, 'jobBad1.json')))
    const bad = JSON.parse(await fsp.readFile(path.join(on.dirs.outboxDir, 'jobBad1.json'), 'utf8'))
    assert.equal(bad.ok, false)
    assert.ok(bad.error)
  } finally { on.stop(); await fsp.rm(root, { recursive: true, force: true }) }
})
