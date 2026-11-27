// tests/blacklist.test.js — .blacklist (plugins/owner/blacklist.js):
// add/del/list + simpan JID+LID, sesi tanya-aksi 15 detik (handler.before),
// penegakan handler.all (kick dari semua grup bila bot admin), dan
// sub-bot (sharing + store terpisah + menu owner). Dijalankan lewat
// pipeline asli + fake socket/db (pola tests/banchat.test.js), dengan
// fakeConn role 'sub' untuk konteks worker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { proto } from '@whiskeysockets/baileys'
import { createPipeline } from '../lib/plugins/pipeline.js'
import { createPluginLoader } from '../lib/plugins/loader.js'
import { scanPluginFiles } from '../lib/plugins/files.js'
import { Database } from '../lib/database/engine.js'
import { fakeConn, raw, PN, LID, BOTLID, BOTPN, GROUP } from './fixtures.js'
import { serialize } from '../lib/simple.js'
import { dayKey } from '../lib/helpers/time.js'
import { digitsOf } from '../lib/helpers/groupTargets.js'
import { scaffoldSandbox } from '../lib/subbot/sandbox.js'
import { SubBotManager } from '../lib/subbot/manager.js'
import { validatePolicyTree, codeHash } from '../lib/subbot/policy.js'
import menu from '../lib/subbot/templates/plugins/main/menu.js'
import banchat from '../plugins/owner/banchat.js'
import blacklist, { createBlacklistActionStore, clearBlacklistKickCooldown, addBlacklistEntry, delBlacklistEntry, findBlacklistEntry, isBlacklisted, listBlacklistEntries } from '../plugins/owner/blacklist.js'

serialize()

const LID2 = '30003@lid'
const STRANGER_PN = '6289999999999@s.whatsapp.net'
const STRANGER_LID = '99999@lid'
const OWNER_REJECT = 'Perintah ini khusus owner.'
const SHORT_GROUP = '123271512@g.us'
// Owner asli (bukan fromMe) untuk tes sesi: perintah + jawaban harus
// datang dari identitas yang sama — fromMe selalu ditolak
// handler.before (pola .pilih), dan perintah dari fromMe mengunci sesi
// ke BOTLID sehingga jawaban owner asli tidak ketemu sesinya.
const OWNER_PN = '6282348181097@s.whatsapp.net'
const OWNER_LID = '147368951459939@lid'
function asRealOwner(t) {
  const prevOwner = global.owner
  global.owner = [['6282348181097', '147368951459939']]
  t.after(() => { if (prevOwner === undefined) delete global.owner; else global.owner = prevOwner })
}
const ownerRealGroup = (s, text) => {
  const m = proto.WebMessageInfo.fromObject({ key: { id: s.nextId(), remoteJid: GROUP, fromMe: false, participant: OWNER_PN }, messageTimestamp: Date.now() / 1000, pushName: 'Owner', message: { conversation: text } })
  m.key.participantAlt = OWNER_LID
  return m
}

function pongPlugin() {
  const p = async (m) => { await m.reply('pong') }
  p.help = ['ping']; p.tags = ['test']; p.command = /^ping$/i; p.limit = true
  return p
}

async function setup(t, { role = 'main' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-blacklist-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const db = await new Database({ dir: root }).load()
  global.db = db
  const prevLimit = global.defaultLimit
  global.defaultLimit = 50
  t.after(() => { global.defaultLimit = prevLimit })
  clearBlacklistKickCooldown()
  const conn = fakeConn({ db, role })
  const loader = { root, list: () => [{ id: 'owner/blacklist.js', plugin: blacklist }, { id: 'test/ping.js', plugin: pongPlugin() }] }
  const pipeline = createPipeline({ db, plugins: loader, config: { prefix: '.', cooldownMs: 0, maxMessageAgeSec: 120 }, log: () => {}, error: () => {} })
  const run = (messages, type = 'notify') => pipeline.handler.call(conn, { type, messages })
  t.after(async () => { await pipeline.close(); await conn.store.close() })
  for (const key of [LID, PN]) {
    const u = db.ensure('users', key)
    u.registered = true; u.limitDay = dayKey(Date.now(), 'Asia/Jakarta'); u.limit = 50
  }
  db.ensure('chats', GROUP).isBanned = false
  const replies = () => conn.calls.filter(c => c.data?.text != null).map(c => c.data.text)
  const kicks = () => conn.calls.filter(c => c.action === 'remove')
  let n = 0
  const nextId = () => 'bl' + (++n)
  return { db, conn, run, replies, kicks, nextId }
}

// Perintah owner: fromMe (bot sendiri = owner di pipeline role main).
const ownerDM = (s, text) => raw(text, { fromMe: true, id: s.nextId() })
const ownerGroup = (s, text) => raw(text, { group: true, fromMe: true, id: s.nextId() })
const ownerGroupReply = (s, text, participant) => raw(text, { group: true, fromMe: true, id: s.nextId(), message: { extendedTextMessage: { text, contextInfo: { quotedMessage: { conversation: 'hai' }, stanzaId: 'q1', participant } } } })
const ownerGroupMention = (s, text, mentioned) => raw(text, { group: true, fromMe: true, id: s.nextId(), message: { extendedTextMessage: { text, contextInfo: { mentionedJid: [mentioned] } } } })
const targetGroup = (s, text = '.ping') => raw(text, { group: true, id: s.nextId() })
const targetGroupText = (s, text) => raw(text, { group: true, id: s.nextId() })
const strangerGroup = (s, text) => raw(text, { group: true, participant: STRANGER_PN, alt: false, id: s.nextId() })
const lid2Group = (s, text) => raw(text, { group: true, participant: LID2, alt: false, id: s.nextId() })

// ─── Metadata ───────────────────────────────────────────────────────────

test('metadata: .blacklist owner-only, tanpa limit, sharing, tag owner', () => {
  assert.equal(blacklist.command.test('blacklist'), true)
  assert.equal(blacklist.command.test('blacklists'), false)
  assert.equal(blacklist.owner, true)
  assert.equal(blacklist.limit, undefined)
  assert.equal(blacklist.sharing, true)
  assert.deepEqual(blacklist.tags, ['owner'])
  assert.deepEqual(blacklist.help, ['blacklist add <target>', 'blacklist del <target>', 'blacklist list'])
  assert.equal(typeof blacklist.before, 'function')
  assert.equal(typeof blacklist.all, 'function')
})

// ─── Store (unit) ───────────────────────────────────────────────────────

test('store: add simpan jid+lid; cari lewat kedua bentuk; del menghapus', async t => {
  const s = await setup(t)
  const saved = await addBlacklistEntry(s.db, s.conn, { jid: PN, lid: LID, addedBy: LID })
  assert.equal(saved.key, LID)
  assert.equal(saved.updated, false)
  assert.ok(saved.addedAt > 0)
  assert.equal(findBlacklistEntry(s.db, s.conn, LID)?.jid, PN)
  assert.equal(findBlacklistEntry(s.db, s.conn, PN)?.lid, LID)
  assert.equal(isBlacklisted(s.db, s.conn, LID), true)
  assert.equal(isBlacklisted(s.db, s.conn, PN), true)
  assert.equal(listBlacklistEntries(s.db).length, 1)
  const removed = await delBlacklistEntry(s.db, s.conn, { jid: PN, lid: LID })
  assert.equal(removed?.key, LID)
  assert.equal(isBlacklisted(s.db, s.conn, LID), false)
  assert.equal(await delBlacklistEntry(s.db, s.conn, { jid: PN, lid: LID }), null)
})

test('store: tambah lewat satu bentuk lalu bentuk lain digabung (bukan duplikat)', async t => {
  const s = await setup(t)
  await addBlacklistEntry(s.db, s.conn, { jid: PN, lid: null, addedBy: LID })
  assert.equal(listBlacklistEntries(s.db).length, 1)
  const merged = await addBlacklistEntry(s.db, s.conn, { jid: PN, lid: LID, addedBy: LID })
  assert.equal(merged.updated, true)
  assert.equal(listBlacklistEntries(s.db).length, 1)
  assert.equal(listBlacklistEntries(s.db)[0].lid, LID)
  assert.equal(listBlacklistEntries(s.db)[0].jid, PN)
})

test('store: del menghapus semua record orang yang sama (dua record sebelum pemetaan diketahui)', async t => {
  const s = await setup(t)
  await addBlacklistEntry(s.db, s.conn, { jid: PN, lid: null, addedBy: LID })
  await addBlacklistEntry(s.db, s.conn, { jid: null, lid: LID2, addedBy: LID })
  assert.equal(listBlacklistEntries(s.db).length, 2)
  // LID2 tidak terpetakan ke PN — dua record terpisah; del dengan
  // kedua bentuk sekaligus harus membersihkan keduanya bila memang
  // satu orang (di sini: del dipanggil dengan target lengkap).
  await delBlacklistEntry(s.db, s.conn, { jid: null, lid: LID2 })
  assert.equal(listBlacklistEntries(s.db).length, 1)
  assert.equal(listBlacklistEntries(s.db)[0].key, PN)
})

// ─── Command: add/del/list ─────────────────────────────────────────────

test('command add via reply: entry jid+lid, balasan masuk blacklist', async t => {
  const s = await setup(t)
  await s.run([ownerGroupReply(s, '.blacklist add', LID)])
  const e = findBlacklistEntry(s.db, s.conn, LID)
  assert.equal(e?.jid, PN)
  assert.equal(e?.lid, LID)
  assert.ok(s.replies().some(x => x.includes('masuk blacklist')), s.replies())
})

test('command add via nomor: entry jid+lid', async t => {
  const s = await setup(t)
  await s.run([ownerGroup(s, '.blacklist add 6281234567890')])
  assert.equal(isBlacklisted(s.db, s.conn, LID), true)
  assert.equal(isBlacklisted(s.db, s.conn, PN), true)
  assert.ok(s.replies().some(x => x.includes('masuk blacklist')), s.replies())
})

test('command add via tag: entry jid+lid', async t => {
  const s = await setup(t)
  await s.run([ownerGroupMention(s, '.blacklist add', LID)])
  assert.equal(isBlacklisted(s.db, s.conn, LID), true)
  assert.ok(s.replies().some(x => x.includes('masuk blacklist')), s.replies())
})

test('command add via LID yang diketik utuh: entry lid-only', async t => {
  const s = await setup(t)
  await s.run([ownerGroup(s, `.blacklist add ${LID2}`)])
  const e = findBlacklistEntry(s.db, s.conn, LID2)
  assert.equal(e?.lid, LID2)
  assert.equal(e?.jid, '')
})

test('command del: hapus lalu del lagi = tidak ada di blacklist', async t => {
  const s = await setup(t)
  await s.run([ownerGroup(s, '.blacklist add 6281234567890')])
  assert.equal(isBlacklisted(s.db, s.conn, LID), true)
  await s.run([ownerGroup(s, `.blacklist del ${LID}`)])
  assert.equal(isBlacklisted(s.db, s.conn, LID), false)
  assert.ok(s.replies().some(x => x.includes('dihapus dari blacklist')), s.replies())
  await s.run([ownerGroup(s, `.blacklist del ${LID}`)])
  assert.ok(s.replies().some(x => x.includes('tidak ada di blacklist')), s.replies())
})

test('command list: kosong vs dua entri', async t => {
  const s = await setup(t)
  await s.run([ownerDM(s, '.blacklist list')])
  assert.ok(s.replies().some(x => x.includes('masih kosong')), s.replies())
  await s.run([ownerGroup(s, '.blacklist add 6281234567890')])
  await s.run([ownerGroup(s, `.blacklist add ${LID2}`)])
  await s.run([ownerDM(s, '.blacklist list')])
  const last = s.replies().at(-1)
  assert.ok(last.includes('6281234567890'), last)
  assert.ok(last.includes('30003'), last)
})

test('command tanpa argumen: pesan pemakaian, bukan throw', async t => {
  const s = await setup(t)
  await s.run([ownerDM(s, '.blacklist')])
  assert.ok(s.replies().some(x => x.includes('.blacklist add')), s.replies())
  assert.equal(listBlacklistEntries(s.db).length, 0)
})

// ─── Sesi tanya-aksi ────────────────────────────────────────────────────

test('sesi: .blacklist <target> bertanya; jawab add dalam 15 detik jalan', async t => {
  const s = await setup(t)
  asRealOwner(t)
  await s.run([ownerRealGroup(s, '.blacklist 6281234567890')])
  assert.ok(s.replies().some(x => x.includes('Mau diapain') && x.includes('add')), s.replies())
  assert.equal(isBlacklisted(s.db, s.conn, LID), false, 'belum masuk sebelum dijawab')
  await s.run([ownerRealGroup(s, 'add')])
  assert.equal(isBlacklisted(s.db, s.conn, LID), true)
  assert.ok(s.replies().some(x => x.includes('masuk blacklist')), s.replies())
})

test('sesi: jawab del menghapus entri yang sudah ada', async t => {
  const s = await setup(t)
  asRealOwner(t)
  await s.run([ownerGroup(s, '.blacklist add 6281234567890')])
  assert.equal(isBlacklisted(s.db, s.conn, LID), true)
  await s.run([ownerRealGroup(s, '.blacklist 6281234567890')])
  await s.run([ownerRealGroup(s, 'del')])
  assert.equal(isBlacklisted(s.db, s.conn, LID), false)
  assert.ok(s.replies().some(x => x.includes('dihapus dari blacklist')), s.replies())
})

test('sesi: penanya lain tidak bisa menjawab; sesi owner tetap terbuka', async t => {
  const s = await setup(t)
  asRealOwner(t)
  await s.run([ownerRealGroup(s, '.blacklist 6281234567890')])
  const before = s.replies().length
  await s.run([strangerGroup(s, 'add')])
  assert.equal(s.replies().length, before, 'jawaban orang lain harus diabaikan tanpa balasan')
  assert.equal(isBlacklisted(s.db, s.conn, LID), false, 'sesi tidak boleh batal oleh jawaban orang lain')
  await s.run([ownerRealGroup(s, 'add')])
  assert.equal(isBlacklisted(s.db, s.conn, LID), true, 'owner masih bisa menjawab sesudahnya')
})

test('sesi: target tidak bisa diurai -> error, TIDAK buka sesi', async t => {
  const s = await setup(t)
  await s.run([ownerGroup(s, '.blacklist xyz')])
  assert.ok(s.replies().some(x => x.includes('tidak dikenali')), s.replies())
  const before = s.replies().length
  await s.run([ownerGroup(s, 'add')])
  assert.equal(s.replies().length, before, 'tidak ada sesi yang bisa dijawab')
  assert.equal(listBlacklistEntries(s.db).length, 0)
})

test('sesi: dijawab setelah 15 detik -> sesi habis + pesan, tidak jalan', async t => {
  const s = await setup(t)
  let nowMs = 1_000_000
  const store = createBlacklistActionStore({ now: () => nowMs })
  const sent = []
  const m = {
    sender: LID, chat: GROUP, isGroup: true, fromMe: false, quoted: null, mentionedJid: [],
    reply: async (text) => { sent.push(String(text)) },
  }
  const ctx = { conn: s.conn, text: '6281234567890', participants: [], groupMetadata: null, blacklistActions: store, isOwner: true, isFounder: false }
  await blacklist(m, ctx)
  // Pertanyaan dikirim lewat conn.reply (bukan m.reply) — cek di replies().
  assert.ok(s.replies().some(x => x.includes('Mau diapain')), s.replies())
  nowMs += 16_000
  const m2 = { ...m, text: 'add' }
  const ctx2 = { conn: s.conn, blacklistActions: store, isOwner: true, isFounder: false }
  assert.equal(await blacklist.before(m2, ctx2), true)
  assert.ok(sent.some(x => x.includes('Sesi sudah habis')), sent)
  assert.equal(isBlacklisted(s.db, s.conn, LID), false)
})

test('sesi: dijawab dalam 15 detik lewat before langsung -> jalan', async t => {
  const s = await setup(t)
  let nowMs = 1_000_000
  const store = createBlacklistActionStore({ now: () => nowMs })
  const sent = []
  const m = {
    sender: LID, chat: GROUP, isGroup: true, fromMe: false, quoted: null, mentionedJid: [],
    reply: async (text) => { sent.push(String(text)) },
  }
  const ctx = { conn: s.conn, text: '6281234567890', participants: [], groupMetadata: null, blacklistActions: store, isOwner: true, isFounder: false }
  await blacklist(m, ctx)
  nowMs += 5_000
  const m2 = { ...m, text: 'ADD' }
  assert.equal(await blacklist.before(m2, { conn: s.conn, blacklistActions: store, isOwner: true, isFounder: false }), true)
  assert.equal(isBlacklisted(s.db, s.conn, LID), true)
})

// ─── Proteksi ───────────────────────────────────────────────────────────

test('proteksi: bot sendiri dan owner/founder tidak bisa di-blacklist', async t => {
  const s = await setup(t)
  await s.run([ownerGroupReply(s, '.blacklist add', BOTLID)])
  assert.ok(s.replies().some(x => x.includes('bot itu sendiri')), s.replies())
  assert.equal(listBlacklistEntries(s.db).length, 0)
  const prevOwner = global.owner
  global.owner = [['6281234567890', '10001']]
  t.after(() => { if (prevOwner === undefined) delete global.owner; else global.owner = prevOwner })
  await s.run([ownerGroup(s, '.blacklist add 6281234567890')])
  assert.ok(s.replies().some(x => x.includes('tidak bisa di-blacklist')), s.replies())
  assert.equal(listBlacklistEntries(s.db).length, 0)
})

test('gerbang owner: bukan owner tidak bisa .blacklist', async t => {
  const s = await setup(t)
  await s.run([targetGroup(s, '.blacklist add 6281234567890')])
  assert.equal(s.replies().at(-1), OWNER_REJECT)
  assert.equal(listBlacklistEntries(s.db).length, 0)
})

// ─── Penegakan (handler.all) ────────────────────────────────────────────

test('enforcement: pengirim blacklist di-kick bila bot admin (pesan biasa, bukan command)', async t => {
  const s = await setup(t)
  await addBlacklistEntry(s.db, s.conn, { jid: PN, lid: LID, addedBy: LID })
  await s.run([targetGroupText(s, 'halo')])
  assert.equal(s.kicks().length, 1)
  assert.equal(s.kicks()[0].action, 'remove')
  assert.ok(s.kicks()[0].ids.some(id => digitsOf(id) === '6281234567890'), s.kicks())
})

test('enforcement: pesan beruntun -> cuma 1 percobaan kick (cooldown 60 dtk)', async t => {
  const s = await setup(t)
  await addBlacklistEntry(s.db, s.conn, { jid: PN, lid: LID, addedBy: LID })
  await s.run([targetGroupText(s, 'halo')])
  await s.run([targetGroup(s, '.ping')])
  assert.equal(s.kicks().length, 1, 'kick kedua dalam 60 detik harus ditahan cooldown')
  assert.ok(s.replies().includes('pong'), 'command tetap diproses (pipeline tidak diubah)')
})

test('enforcement: bot bukan admin -> diam, tidak ada kick', async t => {
  const s = await setup(t)
  await addBlacklistEntry(s.db, s.conn, { jid: PN, lid: LID, addedBy: LID })
  s.conn.groupMetadata = async (id) => ({ id, subject: 'Test group', participants: [{ id: LID, phoneNumber: PN, admin: 'admin' }, { id: BOTLID, phoneNumber: BOTPN, admin: null }] })
  await s.run([targetGroupText(s, 'halo')])
  assert.equal(s.kicks().length, 0)
})

test('enforcement: bukan blacklist / DM / pesan bot sendiri -> diam', async t => {
  const s = await setup(t)
  await addBlacklistEntry(s.db, s.conn, { jid: PN, lid: LID, addedBy: LID })
  // Bukan blacklist: pengirim lain.
  await s.run([strangerGroup(s, 'halo')])
  assert.equal(s.kicks().length, 0)
  // DM dari orang blacklist: handler.all hanya untuk grup.
  await s.run([raw('.ping', { id: s.nextId() })])
  assert.equal(s.kicks().length, 0)
  // Pesan bot sendiri di grup.
  await s.run([raw('halo', { group: true, fromMe: true, id: s.nextId() })])
  assert.equal(s.kicks().length, 0)
})

test('enforcement: kick gagal -> diam tanpa crash; percobaan berikutnya ditahan cooldown', async t => {
  const s = await setup(t)
  await addBlacklistEntry(s.db, s.conn, { jid: PN, lid: LID, addedBy: LID })
  let attempts = 0
  const conn2 = {
    identity: s.conn.identity,
    store: s.conn.store,
    groupParticipantsUpdate: async () => { attempts++; return [{ jid: LID, status: '403' }] },
  }
  const m = { isGroup: true, fromMe: false, sender: LID, chat: GROUP }
  await blacklist.all(m, { conn: conn2 })
  await blacklist.all(m, { conn: conn2 })
  assert.equal(attempts, 1, 'kick gagal tetap dihitung 1x; ulangan ditahan cooldown')
})

test('enforcement: pengirim owner (entri basi) tidak di-kick', async t => {
  const s = await setup(t)
  await addBlacklistEntry(s.db, s.conn, { jid: PN, lid: LID, addedBy: LID })
  const prevOwner = global.owner
  global.owner = [['6281234567890', '10001']]
  t.after(() => { if (prevOwner === undefined) delete global.owner; else global.owner = prevOwner })
  await s.run([targetGroupText(s, 'halo')])
  assert.equal(s.kicks().length, 0)
})

test('enforcement: LID-only di blacklist tetap kena lewat LID pengirim', async t => {
  const s = await setup(t)
  await addBlacklistEntry(s.db, s.conn, { jid: null, lid: LID2, addedBy: LID })
  // Di dunia nyata pengirim adalah peserta grup: metadata membawa
  // phoneNumber-nya sehingga pemetaan LID<->JID dipelajari pipeline
  // (prime) sebelum handler.all jalan. Tanpa pemetaan itu,
  // groupParticipantsUpdate yang dibungkus (lib/simple.js) menolak
  // karena nomor target belum diketahui — kick tidak bisa dicoba.
  s.conn.groupMetadata = async (id) => ({ id, subject: 'Test group', participants: [
    { id: LID, phoneNumber: PN, admin: 'admin' },
    { id: BOTLID, phoneNumber: BOTPN, admin: 'admin' },
    { id: LID2, phoneNumber: '6282112345678@s.whatsapp.net', admin: null },
  ] })
  await s.run([lid2Group(s, 'halo')])
  assert.equal(s.kicks().length, 1)
  assert.ok(s.kicks()[0].ids.some(id => digitsOf(id) === '6282112345678'), s.kicks())
})

// ─── Sub-bot ────────────────────────────────────────────────────────────

test('sub-bot sharing: banchat + blacklist sharing = true dan ikut sharedPluginFiles', async t => {
  assert.equal(banchat.sharing, true)
  assert.equal(blacklist.sharing, true)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-bl-share-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const manager = Object.create(SubBotManager.prototype)
  manager.root = root
  const prev = global.pluginLoader
  global.pluginLoader = {
    list: () => [
      { id: 'owner/banchat.js', plugin: { sharing: true } },
      { id: 'owner/blacklist.js', plugin: { sharing: true } },
    ],
  }
  try {
    assert.deepEqual(manager.sharedPluginFiles(), [
      { id: 'owner/banchat.js', source: path.join(root, 'plugins', 'owner', 'banchat.js') },
      { id: 'owner/blacklist.js', source: path.join(root, 'plugins', 'owner', 'blacklist.js') },
    ])
  } finally {
    if (prev === undefined) delete global.pluginLoader; else global.pluginLoader = prev
  }
})

test('sub-bot sharing: scaffoldSandbox menyalin banchat.js + blacklist.js byte-identik', async t => {
  const botsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-bl-bots-'))
  const templateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-bl-tpl-'))
  t.after(async () => { await fs.rm(botsRoot, { recursive: true, force: true }); await fs.rm(templateRoot, { recursive: true, force: true }) })
  const dir = await scaffoldSandbox(botsRoot, 'session@6281234567890', templateRoot, [
    { source: path.resolve('plugins/owner/banchat.js'), id: 'owner/banchat.js' },
    { source: path.resolve('plugins/owner/blacklist.js'), id: 'owner/blacklist.js' },
  ])
  assert.equal(await fs.readFile(path.join(dir, 'plugins', 'owner', 'banchat.js'), 'utf8'), await fs.readFile(path.resolve('plugins/owner/banchat.js'), 'utf8'))
  assert.equal(await fs.readFile(path.join(dir, 'plugins', 'owner', 'blacklist.js'), 'utf8'), await fs.readFile(path.resolve('plugins/owner/blacklist.js'), 'utf8'))
})

test('sub-bot sharing: hash banchat/blacklist dipercaya policy worker walau plugin kustom mati', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-bl-pol-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  for (const id of ['owner/banchat.js', 'owner/blacklist.js']) {
    const code = await fs.readFile(path.resolve('plugins', id), 'utf8')
    await validatePolicyTree({ root, id, code, allowCustomPlugins: false, templateHashes: [codeHash(code)] })
    await assert.rejects(
      validatePolicyTree({ root, id, code, allowCustomPlugins: false, templateHashes: [] }),
      /Plugin kustom dinonaktifkan/)
  }
})

test('sub-bot store: blacklist main vs sandbox tidak tercampur', async t => {
  const mainDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-bl-main-'))
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-bl-sandbox-'))
  t.after(async () => { await fs.rm(mainDir, { recursive: true, force: true }); await fs.rm(sandboxDir, { recursive: true, force: true }) })
  const mainDb = await new Database({ dir: mainDir }).load()
  const sandboxDb = await new Database({ dir: sandboxDir, sub: true }).load()
  assert.ok(Object.hasOwn(sandboxDb.data, 'blacklist'), 'worker Database memuat koleksi blacklist')
  const conn = fakeConn({ db: mainDb })
  await addBlacklistEntry(mainDb, conn, { jid: PN, lid: LID, addedBy: LID })
  assert.equal(listBlacklistEntries(mainDb).length, 1)
  assert.equal(listBlacklistEntries(sandboxDb).length, 0, 'entri bot utama tidak bocor ke sandbox')
  await addBlacklistEntry(sandboxDb, conn, { jid: null, lid: LID2, addedBy: LID })
  assert.equal(listBlacklistEntries(sandboxDb).length, 1)
  assert.equal(listBlacklistEntries(mainDb).length, 1, 'entri sub-bot tidak bocor ke bot utama')
  await conn.store.close()
})

// ─── Sub-bot: pipeline worker asli (loader sandbox + menu) ──────────────
// Meniru tests/subbotOwner.test.js: scaffoldSandbox + loader dengan
// policy validatePolicyTree + templateHashes (template + hash sumber
// banchat/blacklist, seperti manager._launch) + fakeConn role 'sub'.

async function setupSub(t) {
  const root = path.resolve('.')
  const botsRoot = path.join(root, 'bots')
  await fs.mkdir(botsRoot, { recursive: true })
  const sandbox = await scaffoldSandbox(botsRoot, 'session@6289999999997', path.join(root, 'lib/subbot/templates/plugins'), [
    { source: path.resolve('plugins/owner/banchat.js'), id: 'owner/banchat.js' },
    { source: path.resolve('plugins/owner/blacklist.js'), id: 'owner/blacklist.js' },
  ])
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-bl-sub-'))
  t.after(async () => {
    await fs.rm(sandbox, { recursive: true, force: true })
    await fs.rm(dbDir, { recursive: true, force: true })
  })
  const db = await new Database({ dir: dbDir }).load()
  const prev = {}
  for (const k of ['owner', 'founder', 'mods', 'prefix', 'timezone', 'countryCode', 'defaultLimit', 'namebot', 'bots', 'db']) prev[k] = globalThis[k]
  // Meniru worker.js start(): owner sub-bot = pemilik nomor + nomor itu sendiri.
  globalThis.owner = [['6281234567890', '10001', 'Owner'], ['6282234567890', '', 'self']]
  globalThis.founder = []
  globalThis.mods = []
  globalThis.prefix = '.'
  globalThis.timezone = 'Asia/Jakarta'
  globalThis.countryCode = '62'
  globalThis.defaultLimit = 100
  globalThis.namebot = 'Sailox'
  globalThis.bots = { allowCustomPlugins: 'owner-approval', allowedPackages: [], maxPluginKB: 64, maxPlugins: 30 }
  globalThis.db = db
  t.after(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v } })
  clearBlacklistKickCooldown()
  const templateRoot = path.join(root, 'lib/subbot/templates/plugins')
  const templateHashes = []
  for (const f of await scanPluginFiles(templateRoot)) templateHashes.push(codeHash(await fs.readFile(path.join(templateRoot, f), 'utf8')))
  for (const id of ['owner/banchat.js', 'owner/blacklist.js']) templateHashes.push(codeHash(await fs.readFile(path.join(root, 'plugins', id), 'utf8')))
  const pluginRoot = path.join(sandbox, 'plugins')
  const loader = await createPluginLoader({ root: pluginRoot, policy: (code, ast, id) => validatePolicyTree({ root: pluginRoot, id, code, maxKB: 64, allowCustomPlugins: 'owner-approval', templateHashes, approved: [], allowedPackages: [] }) }).load()
  const prevLoader = globalThis.pluginLoader
  globalThis.pluginLoader = loader
  t.after(() => { if (prevLoader === undefined) delete globalThis.pluginLoader; else globalThis.pluginLoader = prevLoader })
  const conn = fakeConn({ db, role: 'sub' })
  const pipeline = createPipeline({ db, plugins: loader, config: { prefix: '.', cooldownMs: 0, maxMessageAgeSec: 120 }, log: () => {}, error: () => {} })
  const run = messages => pipeline.handler.call(conn, { type: 'notify', messages })
  t.after(async () => { await pipeline.close(); await loader.close(); await conn.store.close() })
  for (const key of [PN, LID, STRANGER_PN, STRANGER_LID]) db.ensure('chats', key).isBanned = false
  // Grup fixture harus dibuka eksplisit: default record chats adalah
  // isBanned: true, dan pipeline mengembalikan pesan dari chat yang
  // di-banchat SEBELUM hook all jalan — tanpa ini penegakan blacklist
  // tidak pernah sampai ke handler.all (keterbatasan yang
  // didokumentasikan di plugin, bukan bug).
  db.ensure('chats', GROUP).isBanned = false
  for (const key of [PN, LID, STRANGER_PN, STRANGER_LID]) {
    const u = db.ensure('users', key)
    u.registered = true; u.limitDay = dayKey(Date.now(), 'Asia/Jakarta'); u.limit = 100
  }
  const replies = () => conn.calls.filter(c => c.data?.text != null).map(c => c.data.text)
  const kicks = () => conn.calls.filter(c => c.action === 'remove')
  let n = 0
  const nextId = () => 'bls' + (++n)
  const ownerMsg = text => raw(text, { id: nextId() })
  const strangerMsg = text => {
    const m = proto.WebMessageInfo.fromObject({ key: { id: nextId(), remoteJid: STRANGER_PN, fromMe: false }, messageTimestamp: Date.now() / 1000, pushName: 'Stranger', message: { conversation: text } })
    m.key.remoteJidAlt = STRANGER_LID
    return m
  }
  return { db, conn, run, replies, kicks, ownerMsg, strangerMsg, nextId }
}

test('sub-bot menu: owner melihat banchat/allowchat/blacklist di seksi *owner*', async t => {
  const s = await setupSub(t)
  await s.run([s.ownerMsg('.menu')])
  const reply = s.replies().at(-1)
  assert.match(reply, /\*owner\*/)
  assert.match(reply, /\.banchat \[target\]/)
  assert.match(reply, /\.allowchat \[target\]/)
  assert.match(reply, /\.blacklist add <target>/)
  assert.match(reply, /\.blacklist del <target>/)
  assert.match(reply, /\.blacklist list/)
  await s.run([s.ownerMsg('.menu owner')])
  assert.match(s.replies().at(-1), /\*owner\*/)
  assert.match(s.replies().at(-1), /\.blacklist add <target>/)
})

test('sub-bot menu: non-owner tanpa seksi *owner*; .menu owner ditolak', async t => {
  const s = await setupSub(t)
  await s.run([s.strangerMsg('.menu')])
  const reply = s.replies().at(-1)
  assert.doesNotMatch(reply, /\*owner\*/)
  for (const name of ['banchat', 'allowchat', 'blacklist']) assert.doesNotMatch(reply, new RegExp(name))
  await s.run([s.strangerMsg('.menu owner')])
  assert.equal(s.replies().at(-1), 'Menu Owner khusus owner sub-bot — kategori ini disembunyikan buat pengguna lain.')
})

test('sub-bot gate: non-owner ditolak .blacklist/.banchat sebelum handler jalan', async t => {
  const s = await setupSub(t)
  await s.run([s.strangerMsg('.blacklist list')])
  assert.equal(s.replies().at(-1), OWNER_REJECT)
  await s.run([s.strangerMsg('.banchat')])
  assert.equal(s.replies().at(-1), OWNER_REJECT)
  assert.equal(listBlacklistEntries(s.db).length, 0)
  assert.equal(s.db.data.chats[GROUP]?.isBanned ?? false, false)
})

test('sub-bot: owner .blacklist add + enforcement kick jalan di konteks sub', async t => {
  const s = await setupSub(t)
  await s.run([s.ownerMsg(`.blacklist add ${LID2}`)])
  assert.equal(isBlacklisted(s.db, s.conn, LID2), true)
  assert.ok(s.replies().some(x => x.includes('masuk blacklist')), s.replies())
  // Peserta LID2 ada di metadata (dengan phoneNumber) supaya pemetaan
  // LID<->JID dipelajari — lihat tes enforcement LID-only di atas.
  s.conn.groupMetadata = async (id) => ({ id, subject: 'Test group', participants: [
    { id: LID, phoneNumber: PN, admin: 'admin' },
    { id: BOTLID, phoneNumber: BOTPN, admin: 'admin' },
    { id: LID2, phoneNumber: '6282112345678@s.whatsapp.net', admin: null },
  ] })
  await s.run([lid2Group(s, 'halo')])
  assert.equal(s.kicks().length, 1)
  assert.equal(s.kicks()[0].action, 'remove')
})
