import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { jidDecode } from '@whiskeysockets/baileys'
import { protoType, serialize } from '../../simple.js'
import { createStore } from '../../store.js'
import { setLogSink, printError } from '../../print.js'
import { Database } from '../../database/engine.js'
import { createPluginLoader } from '../../plugins/loader.js'
import { createPipeline } from '../../plugins/pipeline.js'
import { createConnection } from '../../connection/controller.js'
import { ensureDirs, cleanTmp } from '../../helpers/tmp.js'
import { installPaths } from '../../helpers/paths.js'
import { OutboundQueue } from '../../helpers/queue.js'
import { acquireProcessLock } from '../../helpers/sessionLock.js'
import { dfail } from '../../helpers/messages.js'
import { sendIPC, validIPC } from '../ipc.js'
import { validatePolicyTree } from '../policy.js'
import { sandboxPath } from '../sandbox.js'
import * as handlers from '../../../handler.js'
const codeRoot = fileURLToPath(new URL('../../../', import.meta.url))
const sandbox = path.resolve(process.argv[2] ?? '.')
let connection, db, loader, pipeline, store, heartbeat, autosave, cleanup, started = false, stopping = false, anomalies = 0, releaseLock
const post = (type, payload) => sendIPC(process, type, payload, 'from-worker')
const allowedEnv = new Set(['SUBBOT_ID', 'TMPDIR', 'TMP', 'TEMP', 'TZ', 'NODE_ENV', ...(process.platform === 'win32' ? ['SystemRoot'] : [])])
function selfCheck() { return { configDenied: process.permission?.has('fs.read', path.join(codeRoot, 'config.js')) === false, envMinimal: Object.keys(process.env).every(k => allowedEnv.has(k)), permission: !!process.permission } }
async function shutdown({ logout = false, code = 0 } = {}) {
  if (stopping) return; stopping = true; clearInterval(heartbeat); clearInterval(autosave); clearInterval(cleanup)
  const deadline = setTimeout(() => process.exit(1), 9000); deadline.unref()
  try { await connection?.stop({ logout }); if (logout) await post('status', { state: 'stopped', reason: 'logout-complete' }); await pipeline?.close(); await db?.flush(); await loader?.close(); await store?.close(); await releaseLock?.(); process.exit(code) }
  catch (e) { printError(e); process.exit(1) }
}
async function start(m) {
  if (started) return; started = true
  if (path.resolve(m.sandbox) !== sandbox || path.resolve(process.cwd()) !== sandbox) throw new Error('Sandbox worker tidak cocok')
  await sandboxPath(sandbox, '')
  const check = selfCheck(), c = m.config
  global.founder = []; global.owner = [[m.owner.number, m.owner.lid, m.owner.name], [m.number, '', 'self']]; global.mods = []
  global.prefix = Array.isArray(c.prefix) ? c.prefix.map(x => typeof x === 'object' && x.regex ? new RegExp(x.regex, x.flags) : x) : c.prefix
  global.timezone = c.timezone; global.countryCode = c.countryCode; global.defaultLimit = c.defaultLimit; global.namebot = 'Sailox'; global.cooldownMs = 1000; global.maxMessageAgeSec = 120; global.markOnline = false; global.logPrivacy = 'masked'; global.identity = { mentionForm: 'pn', validate: true, aliasMigration: true, actionFallback: true }; global.legacyAliases = true; global.eror = 'Terjadi kesalahan. Coba lagi nanti.'; global.dfail = dfail
  global.bots = { ...c, enabled: false, allowCustomPlugins: check.configDenied && check.envMinimal ? c.allowCustomPlugins : false }
  global.approvedPlugins = c.approved ?? []
  setLogSink(line => { if (line.includes(' ERROR ')) post('log', { level: 'error', line: 'Error worker; rincian pribadi disamarkan.' }).catch(() => {}) })
  installPaths(); await ensureDirs(sandbox, true); releaseLock = await acquireProcessLock(path.join(sandbox, 'auth/process.lockfile')); protoType(); serialize()
  db = global.db = await new Database({ dir: path.join(sandbox, 'databases'), sub: true }).load()
  loader = await createPluginLoader({ root: path.join(sandbox, 'plugins'), policy: (code, ast, id) => validatePolicyTree({ root: path.join(sandbox, 'plugins'), id, code, maxKB: c.maxPluginKB, allowCustomPlugins: global.bots.allowCustomPlugins, templateHashes: c.templateHashes ?? [], approved: global.approvedPlugins, allowedPackages: c.allowedPackages }) }).load(); loader.watch()
  store = createStore(); pipeline = createPipeline({ db, plugins: loader, root: sandbox })
  await post('status', { state: 'connecting', selfCheck: { ...check, pluginCount: loader.list().length, customEnabled: global.bots.allowCustomPlugins !== false } })
  if (process.argv.includes('--self-check')) { await loader.close(); await store.close(); await db.flush(); await releaseLock(); process.exit(check.configDenied && check.envMinimal ? 0 : 1) }
  connection = createConnection({ role: 'sub', authDir: path.join(sandbox, 'auth'), phoneNumber: m.number, store, db, handlers, outbound: new OutboundQueue(c.outbound), onSocket: sock => { Object.defineProperties(sock, { pipeline: { value: pipeline } }); global.conn = sock }, onPairingCode: code => post('pairing-code', { code }), onStatus: status => {
    if (status.state === 'open') { const me = status.me; global.owner[1][1] = jidDecode(me?.lid)?.user ?? ''; }
    post('status', status).catch(() => shutdown({ code: 1 }))
  } })
  await connection.start()
  heartbeat = setInterval(() => { const { rss, heapUsed } = process.memoryUsage(); post('heartbeat', { t: Date.now(), rss, heapUsed }).catch(() => shutdown({ code: 1 })) }, 10000)
  let saving = false, cleaning = false
  autosave = setInterval(async () => { if (saving) return; saving = true; try { await db.save() } catch (e) { printError(e); await shutdown({ code: 1 }) } finally { saving = false } }, 30000)
  cleanup = setInterval(async () => { if (cleaning) return; cleaning = true; try { await cleanTmp(sandbox) } catch (e) { printError(e) } finally { cleaning = false } }, 60000)
}
process.on('message', m => {
  if (!validIPC(m, 'to-worker')) { if (++anomalies >= 5) shutdown({ code: 1 }); return }
  if (m.type === 'start') start(m).catch(e => post('fatal', { message: 'Worker gagal boot: ' + e.name }).finally(() => shutdown({ code: 1 })))
  else if (m.type === 'peers') connection?.identity.setPeers(m.ids)
  else if (m.type === 'stop') shutdown({ logout: m.logout === true })
  else if (m.type === 'ping') { const { rss, heapUsed } = process.memoryUsage(); post('heartbeat', { t: Date.now(), rss, heapUsed }).catch(() => shutdown({ code: 1 })) }
})
process.on('disconnect', () => shutdown())
process.on('SIGTERM', () => shutdown()); process.on('SIGINT', () => shutdown())
process.on('uncaughtException', () => shutdown({ code: 1 })); process.on('unhandledRejection', () => shutdown({ code: 1 }))
if (!process.send) process.exit(1)
await post('ready', { pid: process.pid })
