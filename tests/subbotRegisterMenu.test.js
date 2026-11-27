// tests/subbotRegisterMenu.test.js — dua celah sub-bot (temuan Veo 2026-11-27):
// - .register WAJIB (gerbang registrasi berlaku di sub-bot) tapi perintahnya
//   tidak ada di sandbox — user non-owner tidak bisa memakai apa pun.
//   Perbaikan: plugins/main/register.js sharing = true; registrasi tercatat
//   di DB sandbox sub-bot, terpisah dari bot utama.
// - .menu <arg> di sub-bot mengembalikan hasil kosong (template lama hanya
//   memfilter tag persis): nomor, alias, "all", dan arg tak dikenal semua
//   gagal. Perbaikan: template menu meniru buildMenuText menu bot utama
//   (plugins/main/menu.js) — navigasi bernomor, nomor urut, alias, all,
//   fallback navigasi untuk arg tak dikenal, owner disembunyikan.
// Harness meniru worker (pola tests/subbotOwner.test.js): sandbox temp +
// shared files + templateHashes seperti manager._launch + pipeline asli +
// fakeConn (role 'sub').
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
import { fakeConn, raw, PN, LID, BOTPN } from './fixtures.js'
import { serialize } from '../lib/simple.js'
import { dayKey } from '../lib/helpers/time.js'
import { scaffoldSandbox } from '../lib/subbot/sandbox.js'
import { validatePolicyTree, codeHash } from '../lib/subbot/policy.js'
import register from '../plugins/main/register.js'
import { buildMenuText as mainBuildMenuText } from '../plugins/main/menu.js'
import { buildMenuText as subBuildMenuText } from '../lib/subbot/templates/plugins/main/menu.js'

serialize()
const SUB_NUMBER = '6282234567890' // BOTPN = nomor sub-bot di tes ini
const STRANGER_PN = '6289999999999@s.whatsapp.net'
const STRANGER_LID = '99999@lid'
const FRESH_PN = '6288888888888@s.whatsapp.net'
const FRESH_LID = '88888@lid'
const UNREG = 'Daftar dulu dengan .register Nama.20'
const OWNER_MENU_REJECT = 'Menu Owner khusus owner sub-bot — kategori ini disembunyikan buat pengguna lain.'

async function setup(t) {
  const root = path.resolve('.')
  const botsRoot = path.join(root, 'bots')
  await fs.mkdir(botsRoot, { recursive: true })
  const templateRoot = path.join(root, 'lib/subbot/templates/plugins')
  const shared = [
    { id: 'main/register.js', source: path.join(root, 'plugins/main/register.js') },
    { id: 'group/unprefix.js', source: path.join(root, 'plugins/group/unprefix.js') },
  ]
  const sandbox = await scaffoldSandbox(botsRoot, 'session@6289999999997', templateRoot, shared)
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-subreg-'))
  const mainDbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-subreg-main-'))
  t.after(async () => {
    await fs.rm(sandbox, { recursive: true, force: true })
    await fs.rm(dbDir, { recursive: true, force: true })
    await fs.rm(mainDbDir, { recursive: true, force: true })
  })
  const db = await new Database({ dir: dbDir }).load()
  const mainDb = await new Database({ dir: mainDbDir }).load()
  const prev = {}
  for (const k of ['owner', 'founder', 'mods', 'prefix', 'timezone', 'countryCode', 'defaultLimit', 'namebot', 'bots', 'db']) prev[k] = globalThis[k]
  globalThis.owner = [['6281234567890', '10001', 'Owner'], [SUB_NUMBER, '', 'self']]
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
  // templateHashes seperti manager._launch: template + file sharing.
  const templateHashes = []
  for (const f of await scanPluginFiles(templateRoot)) templateHashes.push(codeHash(await fs.readFile(path.join(templateRoot, f), 'utf8')))
  for (const f of shared) templateHashes.push(codeHash(await fs.readFile(f.source, 'utf8')))
  const pluginRoot = path.join(sandbox, 'plugins')
  const loader = await createPluginLoader({ root: pluginRoot, policy: (code, ast, id) => validatePolicyTree({ root: pluginRoot, id, code, maxKB: 64, allowCustomPlugins: 'owner-approval', templateHashes, approved: [], allowedPackages: [] }) }).load()
  const prevLoader = globalThis.pluginLoader
  t.after(() => { if (prevLoader === undefined) delete globalThis.pluginLoader; else globalThis.pluginLoader = prevLoader })
  const conn = fakeConn({ db, role: 'sub' })
  const pipeline = createPipeline({ db, plugins: loader, config: { prefix: '.', cooldownMs: 0, maxMessageAgeSec: 120 }, log: () => {}, error: () => {} })
  const run = messages => pipeline.handler.call(conn, { type: 'notify', messages })
  t.after(async () => { await pipeline.close(); await loader.close(); await conn.store.close() })
  for (const key of [PN, LID, STRANGER_PN, STRANGER_LID, FRESH_PN, FRESH_LID]) db.ensure('chats', key).isBanned = false
  // Orang asing terdaftar (user biasa) — untuk tes menu. User segar
  // (FRESH_*) sengaja TIDAK didaftarkan — untuk alur .register.
  for (const key of [STRANGER_PN, STRANGER_LID]) { const u = db.ensure('users', key); u.registered = true; u.limitDay = dayKey(Date.now(), 'Asia/Jakarta'); u.limit = 100 }
  const replies = () => conn.calls.filter(c => c.data?.text != null).map(c => c.data.text)
  let n = 0
  const nextId = () => 'sr' + (++n)
  const ownerMsg = text => raw(text, { id: nextId() })
  const msgFrom = (pn, lid, text) => {
    const m = proto.WebMessageInfo.fromObject({ key: { id: nextId(), remoteJid: pn, fromMe: false }, messageTimestamp: Date.now() / 1000, pushName: 'User', message: { conversation: text } })
    m.key.remoteJidAlt = lid
    return m
  }
  return { db, mainDb, conn, run, replies, sandbox, ownerMsg, strangerMsg: text => msgFrom(STRANGER_PN, STRANGER_LID, text), freshMsg: text => msgFrom(FRESH_PN, FRESH_LID, text) }
}

// ─── .register dibagikan ke sub-bot ──────────────────────────────────────

test('register: sharing = true; register = false (bebas gerbang registrasi)', () => {
  assert.equal(register.sharing, true, '.register dibagikan ke sub-bot')
  assert.equal(register.register, false)
})

test('register sub-bot: belum terdaftar ditolak, .register membuka akses, hanya sekali', async t => {
  const s = await setup(t)
  await s.run([s.freshMsg('.ping')])
  assert.equal(s.replies().at(-1), UNREG)
  await s.run([s.freshMsg('.register Stranger.20')])
  assert.match(s.replies().at(-1), /Pendaftaran berhasil/)
  await s.run([s.freshMsg('.ping')])
  assert.match(s.replies().at(-1), /Pong!/)
  await s.run([s.freshMsg('.register Lagi.30')])
  assert.match(s.replies().at(-1), /sudah terdaftar/)
  const u = s.db.ensure('users', FRESH_LID)
  assert.equal(u.registered, true)
  assert.equal(u.name, 'Stranger')
  assert.equal(u.age, 20)
  // Isolasi: registrasi di sub-bot TIDAK tercatat di DB bot utama.
  assert.equal(s.mainDb.ensure('users', FRESH_LID).registered, false)
})

test('register sub-bot: format salah ditolak dan user tetap belum terdaftar', async t => {
  const s = await setup(t)
  await s.run([s.freshMsg('.register TanpaUmur')])
  assert.match(s.replies().at(-1), /Gunakan \.register Nama\.20/)
  assert.equal(s.db.ensure('users', FRESH_LID).registered, false)
})

// ─── Menu sub-bot = menu bot utama (render) ─────────────────────────────

const FIXTURE_PLUGINS = [
  { help: ['ping'], tags: ['info'], disabled: false },
  { help: ['menu [kategori|nomor|all]'], tags: ['main'], disabled: false },
  { help: ['register Nama.umur'], tags: ['main'], disabled: false },
  { help: ['saveplugin <nama>'], tags: ['owner'], disabled: false },
  { help: ['unprefix <kata>'], tags: ['group'], disabled: false },
]

test('menu: buildMenuText template sama persis dengan plugin utama (jaga sinkron)', () => {
  for (const input of ['', 'list', 'owner', '2', 'grup', 'all', 'asdf', '99']) {
    for (const hideOwner of [false, true]) {
      assert.equal(
        subBuildMenuText({ plugins: FIXTURE_PLUGINS, input, hideOwner }),
        mainBuildMenuText({ plugins: FIXTURE_PLUGINS, input, hideOwner }),
        `input=${JSON.stringify(input)} hideOwner=${hideOwner}`,
      )
    }
  }
})

// ─── Menu sub-bot: argumen (e2e lewat pipeline) ─────────────────────────

test('menu sub-bot owner: .menu = navigasi bernomor; .menu 4 = halaman owner', async t => {
  const s = await setup(t)
  await s.run([s.ownerMsg('.menu')])
  const nav = s.replies().at(-1)
  assert.match(nav, /Quick Navigation/)
  assert.match(nav, /1\. Main — 2 perintah/)
  assert.match(nav, /4\. Owner — 4 perintah/)
  assert.doesNotMatch(nav, /saveplugin/)
  await s.run([s.ownerMsg('.menu 4')])
  const page = s.replies().at(-1)
  assert.match(page, /\*OWNER\*/)
  assert.match(page, /\.saveplugin <nama>/)
  assert.match(page, /\.getplugin <nama>/)
})

test('menu sub-bot owner: alias, all, dan arg tak dikenal', async t => {
  const s = await setup(t)
  await s.run([s.ownerMsg('.menu grup')])
  assert.match(s.replies().at(-1), /\*GROUP\*/)
  assert.match(s.replies().at(-1), /unprefix/)
  await s.run([s.ownerMsg('.menu all')])
  const all = s.replies().at(-1)
  assert.match(all, /\*OWNER\*/)
  assert.match(all, /\*GROUP\*/)
  assert.match(all, /\*INFO\*/)
  assert.match(all, /\.saveplugin <nama>/)
  await s.run([s.ownerMsg('.menu asdf')])
  assert.match(s.replies().at(-1), /Quick Navigation/)
  await s.run([s.ownerMsg('.menu 99')])
  assert.match(s.replies().at(-1), /Quick Navigation/)
})

test('menu sub-bot non-owner: tanpa owner di navigasi/all/nomor; .menu own ditolak', async t => {
  const s = await setup(t)
  await s.run([s.strangerMsg('.menu')])
  const nav = s.replies().at(-1)
  assert.match(nav, /Quick Navigation/)
  assert.match(nav, /1\. Main — 2 perintah/)
  assert.match(nav, /2\. Group — 3 perintah/)
  assert.match(nav, /3\. Info — 2 perintah/)
  assert.doesNotMatch(nav, /Owner/)
  assert.doesNotMatch(nav, /saveplugin/)
  await s.run([s.strangerMsg('.menu all')])
  const all = s.replies().at(-1)
  assert.doesNotMatch(all, /\*OWNER\*/)
  assert.match(all, /\*GROUP\*/)
  assert.match(all, /\*INFO\*/)
  await s.run([s.strangerMsg('.menu 3')])
  assert.match(s.replies().at(-1), /\*INFO\*/)
  assert.match(s.replies().at(-1), /\.ping/)
  await s.run([s.strangerMsg('.menu 4')])
  assert.match(s.replies().at(-1), /Quick Navigation/)
  await s.run([s.strangerMsg('.menu own')])
  assert.equal(s.replies().at(-1), OWNER_MENU_REJECT)
  await s.run([s.strangerMsg('.menu owner')])
  assert.equal(s.replies().at(-1), OWNER_MENU_REJECT)
})
