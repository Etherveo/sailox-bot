// lib/downloader/registry.js
//
// Registry + loader untuk engine downloader (lib/downloader/engines/*.js),
// meniru pola plugin loader yang sudah ada (lib/plugins/loader.js):
//
//  - Engine dimuat dengan import() + penanda versi (?v=N) supaya file yang
//    berubah bisa dimuat ulang TANPA restart proses (hot-reload).
//  - Versi baru yang gagal dimuat / tidak lolos kontrak TIDAK menggantikan
//    versi lama yang sedang aktif — registry hanya menukar setelah impor
//    dan validasi kontrak berhasil.
//  - Folder engines diawasi (fs.watch, debounce): menyunting file engine
//    langsung di disk pun memicu reload, sama seperti watcher plugin.
//  - Kontrak engine: ekspor `id` (string, harus sama dengan nama file),
//    `match(url)`, `getInfo(url)`, `download(url, info, opts)`.
//
// Perintah owner untuk mengelola engine dari chat ada di
// lib/helpers/engineCommands.js (save/get/delete/listengine) — mereka
// menulis file lalu memanggil reloadEngine() di sini.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { parse } from 'acorn'
import { KeyedLock } from '../helpers/lock.js'
import { reportEngineError } from './guardian.js'

export const ENGINE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/

export function engineName(name) {
  if (typeof name !== 'string') throw new Error('Nama engine diperlukan')
  name = name.toLowerCase().replace(/\.js$/, '')
  if (!ENGINE_NAME_RE.test(name)) throw new Error('Nama engine tidak valid (huruf kecil, angka, - atau _)')
  return name
}

const REQUIRED_EXPORTS = ['id', 'match', 'getInfo', 'download']

/**
 * Periksa kode engine SEBELUM ditulis/diimpor: syntax harus valid dan
 * ekspor wajib harus ada. Mengembalikan { code, exports }.
 */
export function inspectEngine(code, maxKB = 512) {
  if (Buffer.isBuffer(code)) code = new TextDecoder('utf-8', { fatal: true }).decode(code)
  if (typeof code !== 'string' || code.includes('\0') || Buffer.byteLength(code) > maxKB * 1024) {
    throw new Error('Kode engine tidak valid/terlalu besar')
  }
  const ast = parse(code, { sourceType: 'module', ecmaVersion: 'latest', locations: true })
  const found = new Set()
  for (const node of ast.body) {
    if (node.type !== 'ExportNamedDeclaration') continue
    if (node.declaration) {
      if (node.declaration.type === 'VariableDeclaration') {
        for (const d of node.declaration.declarations) if (d.id?.name) found.add(d.id.name)
      } else if (node.declaration.id?.name) found.add(node.declaration.id.name)
    }
    for (const spec of node.specifiers ?? []) if (spec.exported?.name) found.add(spec.exported.name)
  }
  const missing = REQUIRED_EXPORTS.filter(name => !found.has(name))
  if (missing.length) throw new Error(`Ekspor wajib engine belum ada: ${missing.join(', ')}`)
  return { code, exports: [...found] }
}

function validateContract(name, mod) {
  if (typeof mod?.id !== 'string' || !mod.id) throw new Error('Engine harus mengekspor `id` (string)')
  if (mod.id !== name) throw new Error(`id engine ("${mod.id}") harus sama dengan nama file ("${name}")`)
  for (const fn of ['match', 'getInfo', 'download']) {
    if (typeof mod[fn] !== 'function') throw new Error(`Engine harus mengekspor fungsi ${fn}()`)
  }
  return mod
}

export function createEngineRegistry({ dir, onError = () => {}, warn = () => {} } = {}) {
  const enginesDir = path.resolve(dir)
  const engines = new Map()    // id -> engine module
  const fileById = new Map()   // id -> nama file (mis. "pixeldrain.js")
  const versions = new Map()  // nama file -> counter versi import
  const lock = new KeyedLock()
  let watcher = null
  let loaded = false

  async function scanFiles() {
    let entries = []
    try { entries = await fsp.readdir(enginesDir, { withFileTypes: true }) } catch { return [] }
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.js') && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort()
  }

  const api = {
    dir: enginesDir,

    has(id) { return engines.has(id) },
    get(id) { return engines.get(id) },
    list() { return [...engines.entries()].map(([engineId, engine]) => ({ id: engineId, engine, file: fileById.get(engineId) })) },
    supportedProviders() { return [...engines.keys()] },

    detectProvider(url = '') {
      for (const [engineId, engine] of engines) {
        try { if (engine.match(url)) return engineId } catch { /* engine rusak tidak boleh mematikan deteksi */ }
      }
      return null
    },

    getEngine(providerId) { return engines.get(providerId) },

    /** Daftarkan engine secara manual (dipakai tes & loader). */
    register(name, mod) {
      name = engineName(name)
      const engine = validateContract(name, mod)
      engines.set(engine.id, engine)
      fileById.set(engine.id, `${name}.js`)
      return engine
    },

    unregister(engineId) {
      const existed = engines.delete(engineId)
      fileById.delete(engineId)
      return existed
    },

    /** Muat (atau muat ulang) SATU file engine dari disk. */
    async reload(fileName) {
      let name
      try {
        name = engineName(fileName)
      } catch (e) {
        // Nama file tidak valid (mis. draf berawalan "_") tidak boleh
        // mematikan seluruh registry — lewati file ini saja, laporkan
        // lewat onError seperti kegagalan muat lainnya.
        onError(e, { engine: String(fileName) })
        return { ok: false, error: e.message }
      }
      const file = `${name}.js`
      return lock.run(file, async () => {
        const filePath = path.join(enginesDir, file)
        let code
        try { code = await fsp.readFile(filePath, 'utf8') } catch (e) {
          if (e.code === 'ENOENT') { api.unregister(name); return { ok: false, removed: true, error: 'File engine tidak ada' } }
          throw e
        }
        try { inspectEngine(code) } catch (e) { onError(e, { engine: file }); return { ok: false, error: e.message } }
        const n = (versions.get(file) ?? 0) + 1
        try {
          const mod = await import(pathToFileURL(filePath).href + '?v=' + n)
          const engine = validateContract(name, mod)
          engines.set(engine.id, engine)
          fileById.set(engine.id, file)
          versions.set(file, n)
          if (n > 50) warn(`Engine ${file} dimuat ulang >50 kali; restart untuk mengembalikan memori ESM`)
          return { ok: true, id: engine.id }
        } catch (e) {
          // Versi lama (bila ada) tetap aktif — registry tidak ditukar.
          onError(e, { engine: file })
          return { ok: false, error: e.message }
        }
      })
    },

    /** Muat semua engine di folder. Idempoten: panggilan berikutnya no-op. */
    async loadAll() {
      if (loaded) return api
      loaded = true
      await fsp.mkdir(enginesDir, { recursive: true })
      for (const file of await scanFiles()) await api.reload(file)
      return api
    },

    /** Paksa muat ulang semua engine dari disk. */
    async reloadAll() {
      loaded = true
      for (const file of await scanFiles()) await api.reload(file)
      const onDisk = new Set((await scanFiles()).map(f => f.replace(/\.js$/, '')))
      for (const engineId of [...engines.keys()]) if (!onDisk.has(engineId)) api.unregister(engineId)
      return api
    },

    /** Awasi folder engines: edit file di disk → hot-reload otomatis. */
    watch() {
      if (watcher) return api
      const debounce = new Map()
      try {
        watcher = fs.watch(enginesDir, { persistent: false }, (_event, fileName) => {
          const file = fileName?.toString()
          if (!file?.endsWith('.js')) return
          clearTimeout(debounce.get(file))
          debounce.set(file, setTimeout(async () => {
            debounce.delete(file)
            try {
              if (await fsp.stat(path.join(enginesDir, file)).catch(() => null)) await api.reload(file)
              else api.unregister(engineName(file))
            } catch (e) { onError(e, { engine: file }) }
          }, 150))
        })
        watcher.on('error', e => onError(e, { engine: '(watcher)' }))
      } catch (e) { onError(e, { engine: '(watcher)' }) }
      return api
    },

    close() { watcher?.close(); watcher = null }
  }

  return api
}

// ─── Singleton untuk bot utama ──────────────────────────────────────────────

const defaultDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'engines')

export const downloaderRegistry = createEngineRegistry({
  dir: defaultDir,
  onError: (e, ctx) => {
    console.error(`[downloader] engine ${ctx?.engine ?? '?'}:`, e.message)
    // Penjaga: kegagalan MEMUAT engine juga dilaporkan ke owner.
    void reportEngineError({ engineId: String(ctx?.engine ?? 'unknown').replace(/\.js$/, ''), phase: 'load', error: e })
  }
})

let ensurePromise = null

/** Pastikan engine bawaan termuat + watcher jalan. Aman dipanggil berkali-kali. */
export function ensureEngines() {
  if (!ensurePromise) {
    ensurePromise = downloaderRegistry.loadAll()
      .then(() => { downloaderRegistry.watch(); return downloaderRegistry })
      .catch(e => { ensurePromise = null; throw e })
  }
  return ensurePromise
}

export function detectProvider(url) { return downloaderRegistry.detectProvider(url) }
export function getEngine(providerId) { return downloaderRegistry.getEngine(providerId) }
export function supportedProviders() { return downloaderRegistry.supportedProviders() }
