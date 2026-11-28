import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fork } from 'node:child_process'
import { setImmediate as tick } from 'node:timers/promises'
import { launcherOptions } from '../lib/subbot/launcher.js'
import { sandboxPath, scaffoldSandbox, deleteSandbox } from '../lib/subbot/sandbox.js'
import { validIPC } from '../lib/subbot/ipc.js'
import { inspectPolicy, codeHash } from '../lib/subbot/policy.js'
import { queueApproval, readApproval } from '../lib/subbot/approval.js'
import { SubBotManager } from '../lib/subbot/manager.js'
import { jadibotCommand } from '../lib/helpers/jadibotCommands.js'
import { Database } from '../lib/database/engine.js'
import { fakeConn, PN, LID, BOTLID } from './fixtures.js'
import listSubHandler from '../lib/subbot/templates/plugins/tools/listplugin.js'
import listMainHandler from '../plugins/owner/listplugin.js'
async function temp(t) { const p = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-sub-')); t.after(() => fs.rm(p, { force: true, recursive: true })); return p }
function config() { return { enabled: true, maxBots: 2, maxPerUser: 1, pairingTimeoutSec: 120, heapMB: 256, spawnStaggerSec: 0, allowCustomPlugins: false, maxPlugins: 30, maxPluginKB: 64, maxDiskMB: 100, outbound: { perChatMs: 1200, perSecond: 3 }, allowedPackages: [], logRelay: 'masked' } }
test('sandbox rejects traversal, symlink and invalid delete; scaffold preserves existing files', async t => { const root = await temp(t); await assert.rejects(sandboxPath(root, '../config.js')); await assert.rejects(sandboxPath(root, '/etc/passwd')); await fs.symlink(os.tmpdir(), path.join(root, 'link')); await assert.rejects(sandboxPath(root, 'link/test'), /Symlink/); await assert.rejects(deleteSandbox(root, '..')); const sandbox = await scaffoldSandbox(root, 'session@6281234567890'); assert.equal(await sandboxPath(root, 'session@6281234567890/auth'), path.join(sandbox, 'auth')); await deleteSandbox(root, 'session@6281234567890'); await assert.rejects(fs.access(sandbox)) })
test('IPC validates direction/type/size and start fields', () => { assert.equal(validIPC({ v: 1, type: 'ready', pid: 1 }, 'from-worker'), true); assert.equal(validIPC({ v: 1, type: 'ready', pid: -1 }, 'from-worker'), false); assert.equal(validIPC({ v: 1, type: 'stop', reason: 'test' }, 'to-worker'), true); assert.equal(validIPC({ v: 1, type: 'pairing-code', code: 'ABCDEFGH' }, 'from-worker'), true); assert.equal(validIPC({ v: 1, type: 'log', level: 'info', line: 'x'.repeat(70000) }, 'from-worker'), false); assert.equal(validIPC({ v: 1, type: 'unknown' }, 'from-worker'), false); assert.equal(validIPC({ v: 1, type: 'start', sandbox: '/' }, 'to-worker'), false) })
test('launcher has minimal environment, write confinement, permission fallbacks and no inherited execArgv', () => { const o = launcherOptions({ root: '/app', sandbox: '/app/bots/session@6281234567890', id: 'session@6281234567890', config: config() }); assert.equal(o.env.PATH, undefined); assert.equal(o.env.HOME, undefined); assert.equal(o.env.NODE_OPTIONS, undefined); assert.ok(o.execArgv.includes('--permission')); assert.ok(!o.execArgv.some(x => x.includes('--allow-child-process'))); assert.ok(!o.execArgv.includes('--allow-fs-read=/app')); const fallback = launcherOptions({ root: '/app', sandbox: '/app/bots/session@6281234567890', id: 'session@6281234567890', config: { ...config(), allowCustomPlugins: true }, flags: new Set() }); assert.equal(fallback.permission, false); assert.equal(fallback.allowCustomPlugins, false) })
test('launcher meneruskan BOT_PROXY ke worker bila di-set, dan tidak bila kosong', () => {
  const prev = process.env.BOT_PROXY
  try {
    process.env.BOT_PROXY = 'http://proxy:3128'
    const o = launcherOptions({ root: '/app', sandbox: '/app/bots/session@6281234567890', id: 'session@6281234567890', config: config() })
    assert.equal(o.env.BOT_PROXY, 'http://proxy:3128')
    assert.equal(o.env.PATH, undefined) // env tetap minimal
    delete process.env.BOT_PROXY
    const o2 = launcherOptions({ root: '/app', sandbox: '/app/bots/session@6281234567890', id: 'session@6281234567890', config: config() })
    assert.equal(o2.env.BOT_PROXY, undefined)
  } finally {
    if (prev === undefined) delete process.env.BOT_PROXY
    else process.env.BOT_PROXY = prev
  }
})
test('sub-bot listplugin template lists sandbox plugins; main listplugin still refuses sub', async t => {
  const root = await temp(t)
  await fs.mkdir(path.join(root, 'main'), { recursive: true }); await fs.mkdir(path.join(root, 'tools'), { recursive: true })
  await fs.writeFile(path.join(root, 'main/ping.js'), 'export default {}')
  await fs.writeFile(path.join(root, 'tools/listplugin.js'), 'export default {}')
  global.pluginLoader = { root }
  t.after(() => { delete global.pluginLoader })
  for (const c of ['lp', 'listp', 'lplugin', 'listplugin']) assert.match(c, listSubHandler.command)
  const replies = []
  const m = { reply: async teks => { replies.push(String(teks)) } }
  await listSubHandler(m, { conn: { role: 'sub' }, text: '' })
  assert.match(replies.at(-1), /\*main\*/); assert.match(replies.at(-1), /\*tools\*/)
  assert.match(replies.at(-1), /Total: 2 plugin di 2 kategori/)
  await assert.rejects(listMainHandler(m, { conn: { role: 'sub' }, text: '' }), /hanya untuk bot utama/)
})
test('policy rejects original owner executors, dynamic import/env and constructor escapes', async () => { for (const name of ['exec', 'eval', 'o']) assert.throws(() => inspectPolicy(awaitableDummy(name)))
  function awaitableDummy(name) { return name === 'exec' ? "let x = new (async()=>{}).constructor('return 1')" : "import cp from 'child_process'" }
  for (const code of ["import('node:child_process')", 'process.env.TOKEN', "(async()=>{}).constructor('x')", 'eval("1")', 'import(name)', 'const x = new RegExp']) assert.throws(() => inspectPolicy(code))
  assert.equal(inspectPolicy("import path from 'node:path'; const handler = async m => m.reply('ok'); handler.command = ['hello']; export default handler").ok, true)
})
test('owner-approval requests retain bounded bytes and content hash', async t => { const root = await temp(t), code = "let handler = async () => {}; handler.tags = ['tools']; export default handler"; const id = await queueApproval(root, 'hello', code, LID); const read = await readApproval(root, id, 64); assert.equal(read.hash, codeHash(code)); await assert.rejects(readApproval(root, '../secret', 64)) })
test('manager owner verification, quotas/rates, handshake/status, stop/delete and restore registry', async t => {
  const root = await temp(t); await fs.mkdir(path.join(root, 'lib/subbot/templates/plugins'), { recursive: true }); await fs.writeFile(path.join(root, 'lib/subbot/templates/plugins/ping.js'), 'export default async () => {}'); const db = await new Database({ dir: path.join(root, 'databases') }).load(), conn = fakeConn({ db }); conn.identity.learn({ lid: LID, jid: PN }); db.ensure('settings', BOTLID).jadibot = true
  global.prefix = '.'; global.timezone = 'Asia/Jakarta'; global.countryCode = '62'; global.defaultLimit = 100
  const spawned = [], sent = [], notifications = []
  const timers = { setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout: () => ({ unref() {} }), clearTimeout() {} }
  function spawn() { const child = new EventEmitter(); Object.assign(child, { connected: true, stdout: new EventEmitter(), stderr: new EventEmitter(), send(m, cb) { sent.push(m); cb?.(); if (m.type === 'stop') setImmediate(() => { child.exitCode = 0; child.connected = false; child.emit('exit', 0) }) }, kill() { child.connected = false; child.exitCode = 1; setImmediate(() => child.emit('exit', 1)) } }); spawned.push(child); return { child, permission: true, allowCustomPlugins: false } }
  const manager = new SubBotManager({ root, db, getConn: () => conn, config: config(), timers, spawn, notify: async (r, text) => notifications.push(text) }); t.after(async () => { await manager.stopAll(); await conn.store.close() })
  await assert.rejects(manager.create('6283234567890', { lid: LID, jid: PN }), e => typeof e === 'string')
  const id = await manager.create('6281234567890', { lid: LID, jid: PN, name: 'User' }); assert.equal(spawned.length, 1); spawned[0].emit('message', { v: 1, type: 'ready', pid: 42 }); for (let i = 0; i < 10; i++) await tick(); await manager.workers.get(id).handling.run('ipc', async () => {}); assert.ok(sent.some(m => m.type === 'start')); spawned[0].emit('message', { v: 1, type: 'status', state: 'open', me: { id: PN, lid: LID } }); await manager.workers.get(id).handling.run('ipc', async () => {}); assert.equal(manager.registry.get(id).status, 'active'); assert.equal(notifications.length, 1); assert.throws(() => manager.authorize(id, '999@lid', false)); await manager.stop(id); assert.equal(manager.registry.get(id).status, 'stopped'); await assert.rejects(manager.create('6281234567890', { lid: LID, jid: PN }), e => typeof e === 'string'); await manager.delete(id); assert.equal(manager.registry.get(id), undefined)
})
test('owner bot utama bisa stop/hapus sesi orang lain; mods tetap ditolak', async t => {
  // Regresi (perintah Veo 2026-11-27): pemilik sesi adalah nomor sub-bot itu
  // sendiri, dan pesan dari nomor bot diabaikan pipeline (m.isBaileys),
  // jadi pemilik sesi tidak bisa .stopjadibot sendiri — owner harus bisa
  // menembus authorize; mods tidak bisa.
  const root = await temp(t); await fs.mkdir(path.join(root, 'lib/subbot/templates/plugins'), { recursive: true }); await fs.writeFile(path.join(root, 'lib/subbot/templates/plugins/ping.js'), 'export default async () => {}'); const db = await new Database({ dir: path.join(root, 'databases') }).load(), conn = fakeConn({ db }); conn.identity.learn({ lid: LID, jid: PN }); db.ensure('settings', BOTLID).jadibot = true
  global.prefix = '.'; global.timezone = 'Asia/Jakarta'; global.countryCode = '62'; global.defaultLimit = 100
  const spawned = [], sent = [], notifications = []
  const timers = { setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout: () => ({ unref() {} }), clearTimeout() {} }
  function spawn() { const child = new EventEmitter(); Object.assign(child, { connected: true, stdout: new EventEmitter(), stderr: new EventEmitter(), send(m, cb) { sent.push(m); cb?.(); if (m.type === 'stop') setImmediate(() => { child.exitCode = 0; child.connected = false; child.emit('exit', 0) }) }, kill() { child.connected = false; child.exitCode = 1; setImmediate(() => child.emit('exit', 1)) } }); spawned.push(child); return { child, permission: true, allowCustomPlugins: false } }
  const manager = new SubBotManager({ root, db, getConn: () => conn, config: { ...config(), maxBots: 5 }, timers, spawn, notify: async (r, text) => notifications.push(text) })
  global.subBotManager = manager
  t.after(async () => { delete global.subBotManager; await manager.stopAll(); await conn.store.close() })
  const replies = []
  const cmd = (command, sender, isOwner, args) => jadibotCommand({ sender, name: 'X', reply: async teks => { replies.push(String(teks)) } }, { conn, command, text: '', args, isOwner })
  async function openSession(number, lid) {
    const id = await manager.create(number, { lid, jid: number + '@s.whatsapp.net', name: 'User' })
    spawned.at(-1).emit('message', { v: 1, type: 'ready', pid: 42 }); for (let i = 0; i < 10; i++) await tick(); await manager.workers.get(id).handling.run('ipc', async () => {})
    spawned.at(-1).emit('message', { v: 1, type: 'status', state: 'open', me: { id: number + '@s.whatsapp.net', lid } }); await manager.workers.get(id).handling.run('ipc', async () => {})
    assert.equal(manager.registry.get(id).status, 'active'); return id
  }
  // (a) pemilik sesi tetap bisa stop sendiri.
  let id = await openSession('6281234567890', LID); await cmd('stopjadibot', LID, false, ['6281234567890']); assert.equal(manager.registry.get(id).status, 'stopped')
  // (b) owner bot utama bisa stop sesi orang lain (GAGAL tanpa perbaikan).
  id = await openSession('6282123456789', '10002@lid'); await cmd('stopjadibot', '999@lid', true, ['6282123456789']); assert.equal(manager.registry.get(id).status, 'stopped')
  // (c) mods/bukan pemilik tetap ditolak, sesi tetap jalan.
  id = await openSession('6282212345678', '10003@lid'); await assert.rejects(cmd('stopjadibot', '999@lid', false, ['6282212345678']), e => e === 'Sesi bukan milik lo atau tidak ditemukan.'); assert.equal(manager.registry.get(id).status, 'active')
  // (d) owner bisa hapus sesi orang lain (sudah bisa sebelumnya — guard).
  id = await openSession('6282312345678', '10004@lid'); await cmd('stopjadibot', '10004@lid', false, ['6282312345678']); await cmd('deljadibot', '999@lid', true, ['6282312345678', 'konfirmasi']); assert.equal(manager.registry.get(id), undefined)
  // (e) mods tidak bisa hapus sesi orang lain.
  id = await openSession('6282412345678', '10005@lid'); await cmd('stopjadibot', '10005@lid', false, ['6282412345678']); await assert.rejects(cmd('deljadibot', '999@lid', false, ['6282412345678', 'konfirmasi']), e => e === 'Sesi bukan milik lo atau tidak ditemukan.'); assert.notEqual(manager.registry.get(id), undefined)
  // Bersihkan sesi yang masih aktif (kasus c) sebelum t.after menghapus
  // direktori sementara — stopAll di t.after tidak lagi menulis apa pun.
  const activeId = manager.registry.list().find(r => r.status === 'active')?.id
  if (activeId) await manager.stop(activeId)
})
test('actual worker self-check with Permission Model: imports, isolated env/db, no WhatsApp socket', { timeout: 20000 }, async t => {
  const root = path.resolve('.'), bots = path.join(root, 'bots'); await fs.mkdir(bots, { recursive: true }); const sandbox = await scaffoldSandbox(bots, 'session@6289999999999', path.join(root, 'lib/subbot/templates/plugins')); t.after(() => fs.rm(sandbox, { recursive: true, force: true })); const opts = launcherOptions({ root, sandbox, id: 'session@6289999999999', config: config() }); const { permission, allowCustomPlugins, ...forkOpts } = opts
  const child = fork(path.join(root, 'lib/subbot/runtime/worker.js'), [sandbox, '--self-check'], forkOpts); const msgs = [], errors = []; const templateRoot = path.join(root, 'lib/subbot/templates/plugins'); const { scanPluginFiles } = await import('../lib/plugins/files.js'); const templateHashes = []; for (const id of await scanPluginFiles(templateRoot)) templateHashes.push(codeHash(await fs.readFile(path.join(templateRoot, id), 'utf8'))); child.stderr.on('data', data => errors.push(data.toString())); child.on('message', m => { msgs.push(m); if (m.type === 'ready') child.send({ v: 1, type: 'start', sandbox, number: '6289999999999', owner: { number: '6281234567890', lid: '10001', name: 'Test' }, config: { prefix: '.', timezone: 'Asia/Jakarta', countryCode: '62', defaultLimit: 100, maxPlugins: 30, maxPluginKB: 64, allowCustomPlugins: false, outbound: { perChatMs: 1200, perSecond: 3 }, templateHashes }, pairing: { needed: false } }) }); t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') }); const exit = await new Promise(resolve => { child.on('exit', resolve); child.on('error', e => { errors.push(e.message); resolve(-1) }) }); assert.equal(exit, 0, errors.join('\n')); const check = msgs.find(m => m.selfCheck)?.selfCheck; assert.equal(check?.configDenied, true); assert.equal(check?.envMinimal, true); assert.equal(check?.pluginCount, 7)
})
test('policy scans relative dependency code before any plugin import', async t => { const root = await temp(t); await fs.writeFile(path.join(root, 'evil.js'), "import cp from 'node:child_process'; export default cp"); const { validatePolicyTree } = await import('../lib/subbot/policy.js'); await assert.rejects(validatePolicyTree({ root, id: 'custom.js', code: "import x from './evil.js'; export default async () => {}", allowCustomPlugins: true }), /Import tidak diizinkan/); await fs.writeFile(path.join(root, 'safe.js'), 'export const text = "hello"'); await validatePolicyTree({ root, id: 'custom.js', code: "import { text } from './safe.js'; export default async m => m.reply(text)", allowCustomPlugins: true }) })
test('package allowlist cannot reopen dangerous Node builtins or core path traversal', () => { assert.throws(() => inspectPolicy("import cp from 'child_process'", { allowedPackages: ['child_process'] })); assert.throws(() => inspectPolicy("import c from '#lib/../config.js'")) })

test('sandboxPath menerima jalur relatif Windows (backslash) dan tetap menolak traversal', async t => {
  const root = await temp(t)
  assert.equal(await sandboxPath(root, 'plugins\\qrcode.js'), path.join(root, 'plugins', 'qrcode.js'))
  assert.equal(await sandboxPath(root, 'plugins/qrcode.js'), path.join(root, 'plugins', 'qrcode.js'))
  await assert.rejects(sandboxPath(root, '..\\escape.js'), /Path sandbox tidak valid/)
  await assert.rejects(sandboxPath(root, '../escape.js'), /Path sandbox tidak valid/)
})
