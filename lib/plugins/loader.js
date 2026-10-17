import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { KeyedLock } from '../helpers/lock.js'
import { sandboxPath } from '../subbot/sandbox.js'
import { inspectPlugin, scanPluginFiles } from './files.js'
import { normalizePlugin } from './normalize.js'
import { watchPlugins } from './watcher.js'
import { logger, printError } from '../print.js'
export function createPluginLoader({ root, publish = true, policy, warn = logger.warn, onError = printError } = {}) {
  const registry = {}, fingerprints = new Map(), counts = new Map(), aliasesWarned = new Set(), lock = new KeyedLock(); let stopWatch
  const sync = () => { const sorted = Object.entries(registry).sort(([a], [b]) => a.localeCompare(b)); for (const key of Object.keys(registry)) delete registry[key]; Object.assign(registry, Object.fromEntries(sorted)); if (publish) global.plugins = registry }
  const api = {
    root: path.resolve(root), registry,
    get(id) { return registry[id] }, list() { return Object.entries(registry).map(([id, plugin]) => ({ id, plugin })) }, byTag(tag) { return api.list().filter(e => e.plugin.tags.includes(tag)) },
    reload(id) { return lock.run(id, async () => {
      const file = await sandboxPath(root, id), code = await fs.readFile(file, 'utf8'), hash = createHash('sha256').update(code).digest('hex')
      if (fingerprints.get(id) === hash) return { ok: true, unchanged: true }
      try {
        const { ast } = inspectPlugin(code); await policy?.(code, ast, id)
        const n = (counts.get(id) ?? 0) + 1
        const mod = await import(pathToFileURL(file).href + '?v=' + n)
        const plugin = normalizePlugin(mod, { warn: msg => { if (!aliasesWarned.has(id)) { aliasesWarned.add(id); warn(`${id}: ${msg}`) } } })
        if (!plugin) throw new Error('Plugin tidak memiliki fungsi atau hook')
        const basename = path.basename(id).toLowerCase()
        if (Object.keys(registry).some(k => k !== id && path.basename(k).toLowerCase() === basename)) warn(`Nama plugin ganda: ${basename}`)
        const claimed = p => (Array.isArray(p.command) ? p.command : [p.command]).filter(x => typeof x === 'string').map(x => x.toLowerCase())
        for (const [other, p] of Object.entries(registry)) if (other !== id && claimed(p).some(c => claimed(plugin).includes(c))) warn(`Command tumpang tindih: ${id}, ${other}`)
        await registry[id]?.unload?.()
        registry[id] = plugin; fingerprints.set(id, hash); counts.set(id, n); if (n > 50) warn(`Plugin ${id} dimuat ulang >50 kali; restart untuk mengembalikan memori ESM`); sync(); return { ok: true }
      } catch (e) { onError(e, { plugin: id }); return { ok: false, error: e.message } }
    }) },
    async remove(id) { return lock.run(id, async () => { await registry[id]?.unload?.(); delete registry[id]; fingerprints.delete(id); sync() }) },
    async load() { await fs.mkdir(root, { recursive: true }); for (const id of await scanPluginFiles(root)) await api.reload(id); sync(); return api },
    watch() { if (!stopWatch) stopWatch = watchPlugins(root, { reload: async id => { try { await api.reload(id) } catch (e) { if (e.code === 'ENOENT') await api.remove(id); else throw e } }, remove: api.remove, onError }); return api },
    async close() { stopWatch?.(); stopWatch = null; for (const { id } of api.list()) await api.remove(id) },
  }
  if (publish) global.pluginLoader = api
  return api
}
