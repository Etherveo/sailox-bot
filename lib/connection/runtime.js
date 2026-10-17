import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { protoType, serialize } from '../simple.js'
import { createStore } from '../store.js'
import { logger, printError } from '../print.js'
import { Database } from '../database/engine.js'
import { createPluginLoader } from '../plugins/loader.js'
import { createPipeline } from '../plugins/pipeline.js'
import { SubBotManager } from '../subbot/manager.js'
import { installPaths } from '../helpers/paths.js'
import { ensureDirs, cleanTmp } from '../helpers/tmp.js'
import { closePrompt } from '../helpers/prompt.js'
import { acquireProcessLock } from '../helpers/sessionLock.js'
import { dfail } from '../helpers/messages.js'
import { createConnection } from './controller.js'
import * as initialHandlers from '../../handler.js'
export async function bootMain({ root, loginMethod, phoneNumber } = {}) {
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = path.join(root, 'tmp')
  await ensureDirs(root); const releaseLock = await acquireProcessLock(path.join(root, 'sessions/process.lockfile')); const earlyExit = () => process.exit(0); process.on('exit', releaseLock.sync); process.once('SIGINT', earlyExit); process.once('SIGTERM', earlyExit); installPaths(); protoType(); serialize(); global.dfail = dfail
  const db = global.db = await new Database({ dir: path.resolve(root, global.database.dir), warn: logger.warn }).load()
  const plugins = await createPluginLoader({ root: path.join(root, 'plugins') }).load(); plugins.watch()
  const store = createStore(), pipeline = createPipeline({ db, plugins, root }), timers = [], handlers = { ...initialHandlers }
  let stopping = false, restored = false, coreWatcher, coreReloadTimer, coreVersion = 0
  const manager = global.subBotManager = new SubBotManager({ root, db, getConn: () => controller.sock })
  const controller = createConnection({ role: 'main', authDir: path.join(root, 'sessions'), store, db, handlers, loginMethod, phoneNumber,
    onSocket: sock => { global.conn = sock; Object.defineProperties(sock, { pipeline: { value: pipeline } }) },
    onStatus: status => {
      logger.info(`Koneksi utama: ${status.state}${status.reason ? ' — ' + status.reason : ''}`)
      if (status.state === 'open') onOpen().catch(e => { printError(e); shutdown(1) })
    },
  })
  controller.on('failure', e => printError(e, { module: 'socket-events' }))
  async function onOpen() {
    controller.identity.learnContext()
    for (const entries of [global.founder, global.owner, global.mods]) for (const e of entries) if (!e[1]) { const lid = await controller.identity.toLid(e[0] + '@s.whatsapp.net'); if (lid) { const { jidDecode } = await import('@whiskeysockets/baileys'); e[1] = jidDecode(lid).user } }
    if (restored) return; restored = true
    let saving = false, cleaning = false
    timers.push(setInterval(async () => { if (saving) return; saving = true; try { await db.save() } catch (e) { printError(e); await shutdown(1) } finally { saving = false } }, global.database.autosaveSec * 1000))
    timers.push(setInterval(async () => { if (cleaning) return; cleaning = true; try { await cleanTmp(root) } catch (e) { printError(e) } finally { cleaning = false } }, 60000))
    if (global.bots.enabled) await manager.restoreAll()
  }
  async function shutdown(code = 0) {
    if (stopping) return; stopping = true
    for (const timer of timers) clearInterval(timer); clearTimeout(coreReloadTimer); coreWatcher?.close(); closePrompt()
    const timeout = setTimeout(() => process.exit(1), 14000); timeout.unref()
    try { await manager.stopAll(); await controller.stop(); await pipeline.close(); await db.flush(); await plugins.close(); await store.close() } catch (e) { printError(e); code = 1 }
    try { await releaseLock() } catch (e) { printError(e); code = 1 }
    clearTimeout(timeout); process.exit(code)
  }
  if (global.hotReloadCore) {
    coreWatcher = fs.watch(path.join(root, 'handler.js'), () => { clearTimeout(coreReloadTimer); coreReloadTimer = setTimeout(async () => { try { const next = await import(pathToFileURL(path.join(root, 'handler.js')).href + '?v=' + ++coreVersion); for (const k of ['handler', 'participantsUpdate', 'groupsUpdate', 'deleteUpdate']) { if (typeof next[k] !== 'function') throw new Error('Handler core tidak valid') } Object.assign(handlers, next) } catch (e) { printError(e, { module: 'core-reload' }) } }, 150) })
  }
  const rejections = []
  process.off('SIGINT', earlyExit); process.off('SIGTERM', earlyExit)
  process.on('SIGINT', () => shutdown()); process.on('SIGTERM', () => shutdown())
  process.on('uncaughtException', e => { printError(e); shutdown(1) })
  process.on('unhandledRejection', e => { printError(e); const now = Date.now(); rejections.push(now); while (rejections[0] < now - 60000) rejections.shift(); if (rejections.length > 20) shutdown(1) })
  await controller.start()
  return { controller, manager, db, plugins, pipeline, shutdown }
}
