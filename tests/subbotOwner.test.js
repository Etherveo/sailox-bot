// tests/subbotOwner.test.js — gerbang owner perintah kelola plugin sub-bot
// (lib/subbot/templates/plugins/tools/{save,get,list,delete}plugin.js +
// main/menu.js):
// - ke-4 perintah bertag 'owner' dan muncul di seksi *owner* menu sub-bot,
//   bukan lagi di *tools* (temuan Veo 2026-11-27: menu sub-bot live
//   menaruhnya di tools);
// - non-owner DITOLAK pipeline ('Perintah ini khusus owner.') SEBELUM
//   handler jalan — handler.owner = true ditegakkan createPipeline yang
//   sama dengan yang dipakai worker (lib/plugins/pipeline.js +
//   permissionFailure), jadi .getplugin tidak bisa membocorkan source,
//   .deleteplugin/.saveplugin tidak bisa menyentuh file;
// - owner sub-bot tetap bisa menjalankannya.
// Harness meniru worker: global.owner = [[nomor owner, lid owner],
// [nomor sub-bot, '', 'self']], loader dari salinan template di sandbox
// temp (scaffoldSandbox — di bawah bots/ repo supaya import #lib di
// template terselesaikan, pola yang sama dengan tes self-check worker),
// policy = validatePolicyTree + templateHashes seperti manager._launch.
// Dijalankan lewat pipeline asli + fakeConn (role 'sub').
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
import saveplugin from '../lib/subbot/templates/plugins/tools/saveplugin.js'
import getplugin from '../lib/subbot/templates/plugins/tools/getplugin.js'
import listplugin from '../lib/subbot/templates/plugins/tools/listplugin.js'
import deleteplugin from '../lib/subbot/templates/plugins/tools/deleteplugin.js'

serialize()
const SUB_NUMBER = '6282234567890' // BOTPN = nomor sub-bot di tes ini
const STRANGER_PN = '6289999999999@s.whatsapp.net'
const STRANGER_LID = '99999@lid'
const OWNER_REJECT = 'Perintah ini khusus owner.'

async function setup(t) {
  const root = path.resolve('.')
  const botsRoot = path.join(root, 'bots')
  await fs.mkdir(botsRoot, { recursive: true })
  const sandbox = await scaffoldSandbox(botsRoot, 'session@6289999999998', path.join(root, 'lib/subbot/templates/plugins'))
  // ID sandbox sengaja BERBEDA dari tes self-check worker di
  // subbot.test.js (session@6289999999999): file-file tes jalan paralel
  // dalam proses terpisah, dan berbagi satu path sandbox membuat salah
  // satu tes bisa menghapus direktori saat tes lain masih memakainya.
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-subowner-'))
  t.after(async () => {
    await fs.rm(sandbox, { recursive: true, force: true })
    await fs.rm(dbDir, { recursive: true, force: true })
  })
  const db = await new Database({ dir: dbDir }).load()
  const prev = {}
  for (const k of ['owner', 'founder', 'mods', 'prefix', 'timezone', 'countryCode', 'defaultLimit', 'namebot', 'bots', 'db']) prev[k] = globalThis[k]
  // Meniru worker.js start(): owner sub-bot = pemilik nomor + nomor itu
  // sendiri; fromMe menjadi owner di sub-bot.
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
  // TemplateHashes dihitung dari template saat ini — seperti manager
  // saat worker 'ready' (manager.js): salinan sandbox yang isinya sama
  // persis dengan template dipercaya tanpa inspeksi AST.
  const templateRoot = path.join(root, 'lib/subbot/templates/plugins')
  const templateHashes = []
  for (const f of await scanPluginFiles(templateRoot)) templateHashes.push(codeHash(await fs.readFile(path.join(templateRoot, f), 'utf8')))
  const pluginRoot = path.join(sandbox, 'plugins')
  const loader = await createPluginLoader({ root: pluginRoot, policy: (code, ast, id) => validatePolicyTree({ root: pluginRoot, id, code, maxKB: 64, allowCustomPlugins: 'owner-approval', templateHashes, approved: [], allowedPackages: [] }) }).load()
  const prevLoader = globalThis.pluginLoader
  t.after(() => { if (prevLoader === undefined) delete globalThis.pluginLoader; else globalThis.pluginLoader = prevLoader })
  const conn = fakeConn({ db, role: 'sub' })
  const pipeline = createPipeline({ db, plugins: loader, config: { prefix: '.', cooldownMs: 0, maxMessageAgeSec: 120 }, log: () => {}, error: () => {} })
  const run = messages => pipeline.handler.call(conn, { type: 'notify', messages })
  t.after(async () => { await pipeline.close(); await loader.close(); await conn.store.close() })
  for (const key of [PN, LID, STRANGER_PN, STRANGER_LID]) db.ensure('chats', key).isBanned = false
  // Orang asing terdaftar (seperti user biasa): gerbang 'owner' di
  // permissionFailure jalan SEBELUM cek registrasi, jadi tes penolakan
  // 4 perintah tidak butuh ini — tapi .menu (tanpa handler.owner)
  // mensyaratkan registrasi, jadi daftarkan agar sampai ke handler menu.
  for (const key of [STRANGER_PN, STRANGER_LID]) { const u = db.ensure('users', key); u.registered = true; u.limitDay = dayKey(Date.now(), 'Asia/Jakarta'); u.limit = 100 }
  const replies = () => conn.calls.filter(c => c.data?.text != null).map(c => c.data.text)
  let n = 0
  const nextId = () => 'so' + (++n)
  const ownerMsg = text => raw(text, { id: nextId() })
  const strangerMsg = text => {
    const m = proto.WebMessageInfo.fromObject({ key: { id: nextId(), remoteJid: STRANGER_PN, fromMe: false }, messageTimestamp: Date.now() / 1000, pushName: 'Stranger', message: { conversation: text } })
    m.key.remoteJidAlt = STRANGER_LID
    return m
  }
  return { db, conn, run, replies, sandbox, ownerMsg, strangerMsg }
}

// ─── Kategori: ke-4 perintah kelola plugin bertag owner ────────────────

test('keempat perintah kelola plugin bertag owner dan bergerbang owner', () => {
  for (const p of [saveplugin, getplugin, listplugin, deleteplugin]) {
    assert.deepEqual(p.tags, ['owner'])
    assert.equal(p.owner, true)
  }
})

// ─── Menu sub-bot: seksi owner hanya untuk owner ────────────────────────

test('menu owner: owner melihat seksi *owner* berisi ke-4 perintah', async t => {
  const s = await setup(t)
  await s.run([s.ownerMsg('.menu')])
  const reply = s.replies().at(-1)
  // Menu sub-bot meniru bot utama: tanpa argumen = Quick Navigation
  // bernomor (perintahnya di halaman kategori, bukan di navigasi).
  assert.match(reply, /Quick Navigation/)
  assert.match(reply, /3\. Owner — 4 perintah/)
  assert.doesNotMatch(reply, /saveplugin/)
  await s.run([s.ownerMsg('.menu owner')])
  assert.match(s.replies().at(-1), /\*OWNER\*/)
  assert.match(s.replies().at(-1), /\.saveplugin <nama>/)
  assert.match(s.replies().at(-1), /\.getplugin <nama>/)
  assert.match(s.replies().at(-1), /\.listplugin/)
  assert.match(s.replies().at(-1), /\.deleteplugin <nama>/)
})

test('menu non-owner: tanpa seksi *owner*, tanpa ke-4 perintah; .menu owner ditolak', async t => {
  const s = await setup(t)
  await s.run([s.strangerMsg('.menu')])
  const reply = s.replies().at(-1)
  assert.match(reply, /Quick Navigation/)
  assert.match(reply, /1\. Main — 1 perintah/)
  assert.match(reply, /2\. Info — 2 perintah/)
  assert.doesNotMatch(reply, /Owner/)
  for (const name of ['saveplugin', 'getplugin', 'listplugin', 'deleteplugin']) assert.doesNotMatch(reply, new RegExp(name))
  await s.run([s.strangerMsg('.menu owner')])
  assert.equal(s.replies().at(-1), 'Menu Owner khusus owner sub-bot — kategori ini disembunyikan buat pengguna lain.')
  await s.run([s.strangerMsg('.menu tools')])
  // Tidak ada kategori tools di template (genname/qrcode/tagme/ukur
  // adalah plugin kustom di sandbox live, bukan template) — argumen
  // yang tidak mengarah ke kategori yang ada kembali ke navigasi.
  assert.match(s.replies().at(-1), /Quick Navigation/)
  for (const name of ['saveplugin', 'getplugin', 'listplugin', 'deleteplugin']) assert.doesNotMatch(s.replies().at(-1), new RegExp(name))
})

// ─── Gerbang owner: non-owner ditolak sebelum handler jalan ─────────────

test('non-owner ditolak di ke-4 perintah kelola plugin, tanpa efek samping', async t => {
  const s = await setup(t)
  for (const cmd of ['.saveplugin evil', '.getplugin ping', '.listplugin', '.deleteplugin ping']) {
    await s.run([s.strangerMsg(cmd)])
    assert.equal(s.replies().at(-1), OWNER_REJECT, cmd)
  }
  // Handler tidak pernah jalan: tidak ada source bocor, tidak ada file
  // terhapus/tertulis, tidak ada antrean persetujuan yang terbentuk.
  assert.ok(!s.replies().some(r => r.includes('p(ing)?')))
  await fs.access(path.join(s.sandbox, 'plugins/info/ping.js'))
  assert.deepEqual((await fs.readdir(path.join(s.sandbox, 'plugins/tools'))).sort(), ['deleteplugin.js', 'getplugin.js', 'listplugin.js', 'saveplugin.js'])
  await assert.rejects(fs.readdir(path.join(s.sandbox, 'src/plugin-requests')), /ENOENT/)
})

// ─── Owner tetap bisa menjalankan ke-4 perintah ─────────────────────────

test('owner .getplugin mengembalikan source plugin', async t => {
  const s = await setup(t)
  await s.run([s.ownerMsg('.getplugin ping')])
  assert.match(s.replies().at(-1), /p\(ing\)\?/)
})

test('owner .listplugin mendaftar plugin sandbox', async t => {
  const s = await setup(t)
  await s.run([s.ownerMsg('.listplugin')])
  const reply = s.replies().at(-1)
  assert.match(reply, /\*info\*/)
  assert.match(reply, /\*tools\*/)
  assert.match(reply, /Total: 7 plugin di 3 kategori/)
})

test('owner .deleteplugin benar-benar menghapus file', async t => {
  const s = await setup(t)
  await s.run([s.ownerMsg('.deleteplugin ping')])
  assert.match(s.replies().at(-1), /Dihapus: info\/ping\.js/)
  await assert.rejects(fs.access(path.join(s.sandbox, 'plugins/info/ping.js')), /ENOENT/)
})

test('owner .saveplugin mode owner-approval masuk antre, bukan langsung tersimpan', async t => {
  const s = await setup(t)
  // pluginCRUD mengantre ke process.cwd()/src/plugin-requests — di worker
  // cwd-nya adalah sandbox; samakan di sini selama tes ini saja.
  const prevCwd = process.cwd()
  process.chdir(s.sandbox)
  t.after(() => process.chdir(prevCwd))
  await s.run([s.ownerMsg('.saveplugin evil let handler = async () => {}; handler.tags = ["tools"]; export default handler')])
  assert.match(s.replies().at(-1), /Menunggu persetujuan operator\. ID: [a-f0-9]{16}/)
  const files = await fs.readdir(path.join(s.sandbox, 'src/plugin-requests'))
  assert.equal(files.length, 1)
  assert.match(files[0], /^[a-f0-9]{16}\.json$/)
})
