import fs from 'node:fs'
import path from 'node:path'
import { scanPluginFiles } from './files.js'
export function watchPlugins(root, { reload, remove, onError }) {
  let watcher, closed = false, pollTimer; const debounce = new Map(), watched = new Map()
  const change = id => { if (closed || !id?.endsWith('.js')) return; id = id.replaceAll(path.sep, '/'); clearTimeout(debounce.get(id)); debounce.set(id, setTimeout(async () => { debounce.delete(id); try { await reload(id) } catch (e) { if (e.code === 'ENOENT') await remove(id); else onError(e) } }, 150)) }
  const poll = async () => { try { const files = await scanPluginFiles(root); for (const id of files) if (!watched.has(id)) { const file = path.join(root, id), listener = (curr, prev) => { if (curr.mtimeMs !== prev.mtimeMs || !curr.nlink) change(id) }; fs.watchFile(file, { interval: 1000, persistent: false }, listener); watched.set(id, { file, listener }); change(id) } for (const [id, v] of watched) if (!files.includes(id)) { fs.unwatchFile(v.file, v.listener); watched.delete(id); await remove(id) } } catch (e) { onError(e) } }
  const fallback = () => { watcher?.close(); if (!pollTimer) { pollTimer = setInterval(poll, 1500); pollTimer.unref(); poll() } }
  try { watcher = fs.watch(root, { recursive: true }, (_, file) => change(file?.toString())); watcher.on('error', fallback) } catch { fallback() }
  return () => { closed = true; watcher?.close(); clearInterval(pollTimer); for (const t of debounce.values()) clearTimeout(t); for (const v of watched.values()) fs.unwatchFile(v.file, v.listener) }
}
