// tests/subbotSharingMedia.test.js — .s/.sa/.unprefix untuk sub-bot:
//
// - .unprefix: handler.sharing = true (ikut tercopy ke sandbox + hash-nya
//   dipercaya policy worker); daftarnya disimpan TERPISAH lewat
//   lib/helpers/unprefixStore.js — bot utama di chat.unprefix, sub-bot di
//   koleksi 'unprefix' (databases/unprefix.json di dalam sandbox).
// - .s/.sa: sharing = true SEJAK channel konversi ada (tes di
//   tests/subbotStickerConvert.test.js). Worker tetap tanpa
//   --allow-child-process (invariant tests/subbot.test.js:23): konversi
//   ffmpeg dilempar ke bot utama lewat IPC 'sticker-convert' /
//   'sticker-result' (lib/subbot/convertClient.js +
//   lib/subbot/convertService.js), auto-approve, validasi berlapis.
//   pack/author ditempel sub-bot (pure-JS) hanya bila user memberikannya.
// Dijalankan lewat pipeline asli + fake socket/db (pola
// tests/unprefix.test.js), dengan fakeConn role 'sub' untuk konteks worker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createPipeline } from '../lib/plugins/pipeline.js'
import { Database } from '../lib/database/engine.js'
import { fakeConn, raw, PN, LID, BOTLID, GROUP } from './fixtures.js'
import { dayKey } from '../lib/helpers/time.js'
import { serialize } from '../lib/simple.js'
import { scaffoldSandbox } from '../lib/subbot/sandbox.js'
import { SubBotManager } from '../lib/subbot/manager.js'
import { codeHash, validatePolicyTree } from '../lib/subbot/policy.js'
import { getUnprefixWords, setUnprefixWords, isSubBotContext } from '../lib/helpers/unprefixStore.js'
import unprefix from '../plugins/group/unprefix.js'
import sticker from '../plugins/sticker/sticker.js'
import stickeraudio from '../plugins/sticker/stickeraudio.js'
import ping from '../plugins/info/ping.js'

serialize()
const MEMBER = { id: '555000111222@lid', lid: '555000111222@lid', phoneNumber: '6289528749986@s.whatsapp.net', admin: null }
const ADMIN_PARTS = [
  { id: LID, phoneNumber: PN, admin: 'admin' },
  { id: BOTLID, phoneNumber: '6282234567890@s.whatsapp.net', admin: 'admin' },
  MEMBER,
]
const MAIN = { role: 'main' }
const SUB = { role: 'sub' }

async function tmpDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

// ─── Sharing: .unprefix ikut, .s/.sa ikut lewat channel konversi ───────

test('sharing: .unprefix sharing = true; .s/.sa sharing = true (channel konversi)', () => {
  assert.equal(unprefix.sharing, true, '.unprefix dibagikan ke sub-bot')
  assert.equal(unprefix.tags.includes('group'), true)
  assert.equal(sticker.sharing, true, '.s dibagikan ke sub-bot: konversi dilempar ke bot utama lewat IPC sticker-convert (ffmpeg tetap diblokir di worker)')
  assert.equal(stickeraudio.sharing, true, '.sa dibagikan ke sub-bot: konversi dilempar ke bot utama lewat IPC sticker-convert (ffmpeg tetap diblokir di worker)')
})

test('sharing: manager.sharedPluginFiles mengambil group/unprefix.js + plugin stiker', async t => {
  const root = await tmpDir(t, 'sailox-share-media-root-')
  const manager = Object.create(SubBotManager.prototype)
  manager.root = root
  const prev = global.pluginLoader
  global.pluginLoader = {
    list: () => [
      { id: 'group/unprefix.js', plugin: { sharing: true } },
      { id: 'sticker/sticker.js', plugin: { sharing: true } },
      { id: 'sticker/stickeraudio.js', plugin: { sharing: true } },
    ],
  }
  try {
    assert.deepEqual(manager.sharedPluginFiles(), [
      { id: 'group/unprefix.js', source: path.join(root, 'plugins', 'group', 'unprefix.js') },
      { id: 'sticker/sticker.js', source: path.join(root, 'plugins', 'sticker', 'sticker.js') },
      { id: 'sticker/stickeraudio.js', source: path.join(root, 'plugins', 'sticker', 'stickeraudio.js') },
    ])
  } finally {
    if (prev === undefined) delete global.pluginLoader; else global.pluginLoader = prev
  }
})

test('sharing: scaffoldSandbox menyalin group/unprefix.js (file asli) ke sandbox', async t => {
  const botsRoot = await tmpDir(t, 'sailox-share-media-bots-')
  const templateRoot = await tmpDir(t, 'sailox-share-media-tpl-')
  const source = path.resolve('plugins/group/unprefix.js')
  const dir = await scaffoldSandbox(botsRoot, 'session@6281234567890', templateRoot, [{ source, id: 'group/unprefix.js' }])
  assert.equal(await fs.readFile(path.join(dir, 'plugins', 'group', 'unprefix.js'), 'utf8'), await fs.readFile(source, 'utf8'))
})

test('sharing: hash group/unprefix.js dipercaya policy worker walau plugin kustom mati', async t => {
  const root = await tmpDir(t, 'sailox-share-media-pol-')
  const code = await fs.readFile(path.resolve('plugins/group/unprefix.js'), 'utf8')
  await validatePolicyTree({ root, id: 'group/unprefix.js', code, allowCustomPlugins: false, templateHashes: [codeHash(code)] })
  await assert.rejects(
    validatePolicyTree({ root, id: 'group/unprefix.js', code, allowCustomPlugins: false, templateHashes: [] }),
    /Plugin kustom dinonaktifkan/)
})

function runNode(args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('probe timeout')) }, timeout)
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('exit', () => { clearTimeout(timer); resolve({ out, err }) })
  })
}

test('blocker ffmpeg: execFile ditolak ERR_ACCESS_DENIED di bawah --permission (tanpa --allow-child-process)', { timeout: 30000 }, async t => {
  // execFile melempar SYNCHRONOUS (uncaught → proses mati) bila API-nya
  // diblokir permission model, jadi tangkap dulu baru cetak kodenya.
  const probe = `try { require('node:child_process').execFile('ffmpeg', ['-version'], e => { console.log(e ? e.code : 'OK') }) } catch (e) { console.log(e.code || e.message) }`
  const plain = await runNode(['-e', probe])
  if (plain.out.trim() !== 'OK') t.skip('ffmpeg tidak terpasang di mesin ini — blocker tidak bisa dibuktikan di sini')
  const locked = await runNode(['--permission', '-e', probe])
  assert.match(locked.out, /ERR_ACCESS_DENIED/, 'worker (yang selalu jalan dengan --permission) tidak bisa spawn ffmpeg; .s/.sa tidak bisa jalan di sana')
})

// ─── Helper store: main vs sub-bot ───────────────────────────────────────

test('store: konteks utama baca/tulis chat.unprefix; koleksi unprefix tidak tersentuh', async t => {
  const root = await tmpDir(t, 'sailox-unprefix-store-main-')
  const db = await new Database({ dir: root }).load()
  assert.equal(isSubBotContext(MAIN), false)
  assert.equal(isSubBotContext(undefined), false, 'penanda hilang → fallback aman ke perilaku bot utama')
  assert.equal(isSubBotContext({}), false)
  assert.deepEqual(getUnprefixWords(db, GROUP, MAIN), [])
  await setUnprefixWords(db, GROUP, MAIN, ['Ping', 'SA', 'ping'])
  assert.deepEqual(getUnprefixWords(db, GROUP, MAIN), ['ping', 'sa'], 'normalisasi huruf kecil + dedup')
  assert.deepEqual(db.data.chats[GROUP].unprefix, ['ping', 'sa'])
  assert.deepEqual(db.data.unprefix, {}, 'koleksi unprefix tidak tersentuh di konteks utama')
  await setUnprefixWords(db, GROUP, MAIN, [])
  assert.deepEqual(getUnprefixWords(db, GROUP, MAIN), [])
})

test('store: konteks sub-bot baca/tulis koleksi unprefix (databases/unprefix.json); chats tidak tersentuh', async t => {
  const root = await tmpDir(t, 'sailox-unprefix-store-sub-')
  const db = await new Database({ dir: root, sub: true }).load()
  assert.equal(isSubBotContext(SUB), true)
  assert.deepEqual(getUnprefixWords(db, GROUP, SUB), [])
  assert.equal(Object.hasOwn(db.data.unprefix, GROUP), false, 'baca tidak membuat record hantu')
  await setUnprefixWords(db, GROUP, SUB, ['ping'])
  assert.deepEqual(getUnprefixWords(db, GROUP, SUB), ['ping'])
  assert.deepEqual(db.data.unprefix[GROUP].words, ['ping'])
  assert.deepEqual(db.data.chats[GROUP]?.unprefix ?? [], [], 'chats tidak tersentuh di konteks sub-bot')
  const onDisk = JSON.parse(await fs.readFile(path.join(root, 'unprefix.json'), 'utf8'))
  assert.deepEqual(onDisk[GROUP], { words: ['ping'] }, 'JSON khusus di dalam DB sub-bot (bukan chats.json)')
})

test('store: daftar utama dan sub-bot tidak bocor satu sama lain (satu DB)', async t => {
  const root = await tmpDir(t, 'sailox-unprefix-store-iso-')
  const db = await new Database({ dir: root }).load()
  await setUnprefixWords(db, GROUP, MAIN, ['ping'])
  await setUnprefixWords(db, GROUP, SUB, ['sa'])
  assert.deepEqual(getUnprefixWords(db, GROUP, MAIN), ['ping'])
  assert.deepEqual(getUnprefixWords(db, GROUP, SUB), ['sa'])
  assert.deepEqual(getUnprefixWords(db, GROUP, undefined), ['ping'], 'tanpa penanda → daftar utama')
  await setUnprefixWords(db, GROUP, SUB, [])
  assert.deepEqual(getUnprefixWords(db, GROUP, SUB), [])
  assert.deepEqual(getUnprefixWords(db, GROUP, MAIN), ['ping'], 'hapus daftar sub-bot tidak menghapus daftar utama')
})

// ─── Pipeline konteks sub-bot (fakeConn role 'sub') ───────────────────────

const ENTRIES = [
  { id: 'group/unprefix.js', plugin: unprefix },
  { id: 'info/ping.js', plugin: ping },
]

async function setupSub(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-unprefix-sub-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const db = await new Database({ dir: root, sub: true }).load()
  global.db = db
  const prevLimit = global.defaultLimit
  global.defaultLimit = 50
  t.after(() => { global.defaultLimit = prevLimit })
  const connSub = fakeConn({ db, role: 'sub' })
  const connMain = fakeConn({ db, role: 'main' })
  for (const conn of [connSub, connMain]) conn.groupMetadata = async id => ({ id, subject: 'Test group', participants: ADMIN_PARTS })
  const loader = { root, list: () => ENTRIES }
  const prevLoader = globalThis.pluginLoader
  globalThis.pluginLoader = loader
  t.after(() => { if (prevLoader === undefined) delete globalThis.pluginLoader; else globalThis.pluginLoader = prevLoader })
  const pipe = conn => createPipeline({ db, plugins: loader, config: { prefix: '.', cooldownMs: 0, maxMessageAgeSec: 120 }, log: () => {}, error: () => {} })
  const pipeSub = pipe(connSub), pipeMain = pipe(connMain)
  const runSub = messages => pipeSub.handler.call(connSub, { type: 'notify', messages })
  const runMain = messages => pipeMain.handler.call(connMain, { type: 'notify', messages })
  t.after(async () => { await pipeSub.close(); await pipeMain.close(); await connSub.store.close(); await connMain.store.close() })
  for (const key of [LID, PN, MEMBER.id]) {
    const u = db.ensure('users', key)
    u.registered = true; u.limitDay = dayKey(Date.now(), 'Asia/Jakarta'); u.limit = 50
  }
  db.ensure('chats', GROUP).isBanned = false
  db.ensure('chats', PN).isBanned = false
  const repliesOf = conn => conn.calls.filter(c => c.data?.text != null).map(c => c.data.text)
  let n = 0
  const nextId = () => 's' + (++n)
  const setPremium = (key, on) => { const u = db.ensure('users', key); u.premium = on; u.premiumTime = 0 }
  return { db, root, connSub, connMain, runSub, runMain, repliesSub: () => repliesOf(connSub), repliesMain: () => repliesOf(connMain), nextId, setPremium }
}

const founderMsg = (s, text) => raw(text, { group: true, fromMe: true, id: s.nextId() })
const adminMsg = (s, text) => raw(text, { group: true, id: s.nextId() })
const memberMsg = (s, text) => raw(text, { group: true, participant: MEMBER.id, alt: false, id: s.nextId() })

test('sub: founder .unprefix ping → tersimpan di koleksi unprefix, chats tidak tersentuh', async t => {
  const s = await setupSub(t)
  await s.runSub([founderMsg(s, '.unprefix ping')])
  assert.ok(s.repliesSub().some(x => x.startsWith('✅ *ping*')), s.repliesSub())
  assert.deepEqual(s.db.data.unprefix[GROUP].words, ['ping'])
  assert.deepEqual(s.db.data.chats[GROUP].unprefix, [], 'store utama tidak tersentuh dari sub-bot')
  const onDisk = JSON.parse(await fs.readFile(path.join(s.root, 'unprefix.json'), 'utf8'))
  assert.deepEqual(onDisk[GROUP], { words: ['ping'] })
})

test('sub: bare p dan bare ping memicu Pong dari daftar sub-bot', async t => {
  const s = await setupSub(t)
  await setUnprefixWords(s.db, GROUP, SUB, ['ping'])
  let before = s.repliesSub().length
  await s.runSub([adminMsg(s, 'p')])
  assert.ok(s.repliesSub().slice(before).some(x => x.startsWith('Pong!')), s.repliesSub())
  before = s.repliesSub().length
  await s.runSub([adminMsg(s, 'ping')])
  assert.ok(s.repliesSub().slice(before).some(x => x.startsWith('Pong!')), s.repliesSub())
})

test('sub: daftar utama tidak bocor ke sub-bot dan sebaliknya', async t => {
  const s = await setupSub(t)
  await setUnprefixWords(s.db, GROUP, MAIN, ['ping'])
  let before = s.repliesSub().length
  await s.runSub([adminMsg(s, 'p')])
  assert.equal(s.repliesSub().length, before, 'daftar utama (chats.unprefix) tidak boleh memicu fallback di sub-bot')
  await setUnprefixWords(s.db, GROUP, MAIN, [])
  await setUnprefixWords(s.db, GROUP, SUB, ['ping'])
  before = s.repliesMain().length
  await s.runMain([adminMsg(s, 'p')])
  assert.equal(s.repliesMain().length, before, 'daftar sub-bot tidak boleh memicu fallback di bot utama')
  before = s.repliesSub().length
  await s.runSub([adminMsg(s, 'p')])
  assert.ok(s.repliesSub().slice(before).some(x => x.startsWith('Pong!')), 'daftar sub-bot tetap jalan di sub-bot')
})

test('sub: member biasa (premium) ditolak .unprefix — gerbang admin tetap berlaku', async t => {
  const s = await setupSub(t)
  s.setPremium(MEMBER.id, true)
  await s.runSub([memberMsg(s, '.unprefix ping')])
  assert.ok(s.repliesSub().some(x => x === 'Perintah ini khusus admin grup.'), s.repliesSub())
  assert.deepEqual(getUnprefixWords(s.db, GROUP, SUB), [], 'daftar sub-bot tidak berubah')
})

test('sub: .unprefix del via alias menghapus dari koleksi unprefix', async t => {
  const s = await setupSub(t)
  await s.runSub([founderMsg(s, '.unprefix ping')])
  assert.deepEqual(getUnprefixWords(s.db, GROUP, SUB), ['ping'])
  await s.runSub([founderMsg(s, '.unprefix del p')])
  assert.ok(s.repliesSub().some(x => x.includes('dihapus dari daftar tanpa prefix')), s.repliesSub())
  assert.deepEqual(getUnprefixWords(s.db, GROUP, SUB), [])
  assert.deepEqual(s.db.data.chats[GROUP].unprefix, [], 'chats utama tetap tidak tersentuh')
})
