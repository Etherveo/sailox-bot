import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as collections from './collections/index.js'
import { KeyedLock } from '../helpers/lock.js'

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const unsafe = key => ['__proto__', 'prototype', 'constructor'].includes(key)
function safeKey(key) { if (typeof key !== 'string' || !key || unsafe(key)) throw new Error('Kunci database tidak valid') }
export function fillMissing(record, defaults) {
  for (const [key, value] of Object.entries(defaults)) {
    if (unsafe(key)) throw new Error('Field database tidak aman')
    if (!Object.hasOwn(record, key) || (typeof value === 'number' && (typeof record[key] !== 'number' || !Number.isFinite(record[key]))) || (typeof value === 'boolean' && typeof record[key] !== 'boolean')) record[key] = structuredClone(value)
    else if (object(value)) { if (!object(record[key])) record[key] = structuredClone(value); else fillMissing(record[key], value) }
  }
  return record
}
export function stableJSON(data) {
  const sort = v => Array.isArray(v) ? v.map(sort) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v
  return JSON.stringify(sort(data), null, 2) + '\n'
}
const digest = text => createHash('sha256').update(text).digest('hex')
function parseObject(text) { const v = JSON.parse(text); if (!object(v)) throw new Error('Harus objek JSON'); return v }
async function readJSON(file, warn) {
  try { const text = await fs.readFile(file, 'utf8'); return { value: parseObject(text), recovered: false, missing: false } }
  catch (e) {
    if (e.code === 'ENOENT') return { value: {}, missing: true, recovered: false }
    try { const value = parseObject(await fs.readFile(file + '.bak', 'utf8')); warn(`Memakai cadangan valid: ${path.basename(file)}`); return { value, recovered: true, missing: false } }
    catch (backupError) { throw new Error(`Database ${path.basename(file)} tidak valid; cadangan tidak valid. Boot dibatalkan.`, { cause: backupError }) }
  }
}
export class Database {
  constructor({ dir, descriptors = Object.values(collections), sub = false, warn = () => {} } = {}) {
    this.dir = path.resolve(dir); this.descriptors = descriptors.filter(d => !sub || d.name !== 'subbots'); this.warn = warn; this.data = {}; this.hashes = new Map(); this.extensions = {}; this.generation = {}; this.filled = new WeakMap(); this.lock = new KeyedLock(); this.writer = new KeyedLock(); this.loaded = false
    for (const d of this.descriptors) { if (!/^[a-z][a-z0-9_]*$/.test(d.name)) throw new Error('Nama collection tidak valid'); this.data[d.name] = {}; this.extensions[d.name] = {}; this.generation[d.name] = 0 }
  }
  async load() {
    if (this.loaded) return this
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    const meta = await readJSON(path.join(this.dir, '_meta.json'), this.warn); this.meta = meta.value; const originalMetaHash = digest(stableJSON(meta.value))
    for (const d of this.descriptors) {
      const result = await readJSON(path.join(this.dir, d.name + '.json'), this.warn); this.data[d.name] = result.value
      if (Number(this.meta[d.name] ?? 0) > d.version) throw new Error(`Skema ${d.name} lebih baru dari runtime`)
      for (const [key, record] of Object.entries(result.value)) {
        safeKey(key)
        if (!object(record)) throw new Error(`Record ${d.name} tidak valid`)
        if ((this.meta[d.name] ?? 0) < d.version) { fillMissing(record, d.defaults(key)); await d.migrate?.(record, this.meta[d.name] ?? 0) }
      }
      // Keep the original hash so migrations and recovery become dirty.
      this.hashes.set(d.name, result.recovered || result.missing || (this.meta[d.name] ?? 0) < d.version ? null : digest(stableJSON(result.value)))
      this.meta[d.name] = d.version
    }
    this.hashes.set('_meta', meta.recovered || meta.missing ? null : originalMetaHash)
    this.loaded = true; await this.save(); return this
  }
  ensure(name, key, seed = {}) {
    safeKey(key); const d = this.descriptors.find(d => d.name === name); if (!d) throw new Error('Collection tidak dikenal')
    let record = this.data[name][key]
    if (!record) record = this.data[name][key] = {}
    if (!object(record)) throw new Error(`Record ${name} tidak valid`)
    if (this.filled.get(record) !== this.generation[name]) { fillMissing(record, d.defaults(key, seed)); fillMissing(record, this.extensions[name]); this.filled.set(record, this.generation[name]) }
    if (name === 'users') for (const k of ['name', 'jid', 'lid']) if (typeof seed[k] === 'string' && seed[k]) record[k] = seed[k]
    return record
  }
  extend(name, fragment) { if (!this.extensions[name] || !object(fragment)) throw new Error('Ekstensi database tidak valid'); fillMissing(this.extensions[name], fragment); this.generation[name]++ }
  update(name, key, fn) { return this.lock.run(`${name}:${key}`, () => fn(this.ensure(name, key))) }
  save(name) { return this.writer.run('writer', async () => {
    if (!this.loaded) throw new Error('Database belum dimuat')
    const names = name ? [name] : [...this.descriptors.map(d => d.name), '_meta']
    for (const n of names) {
      if (n !== '_meta' && !Object.hasOwn(this.data, n)) throw new Error('Collection tidak dikenal')
      const text = stableJSON(n === '_meta' ? this.meta : this.data[n]); const hash = digest(text)
      if (hash === this.hashes.get(n)) continue
      if (Buffer.byteLength(text) > 20 * 1024 * 1024) this.warn(`Collection ${n} melampaui 20 MB`)
      const file = path.join(this.dir, n + '.json'); const tmp = file + '.tmp'
      const handle = await fs.open(tmp, 'w', 0o600)
      // fsync ditoleransi gagal KHUSUS ERR_ACCESS_DENIED: di bawah Node
      // Permission Model (worker subbot) API fsync dimatikan total oleh
      // Node, jadi di sana tulis tetap atomik lewat rename tapi tanpa
      // jaminan fsync — di luar model itu error fsync tetap dilempar.
      try { await handle.writeFile(text); try { await handle.sync() } catch (e) { if (e.code !== 'ERR_ACCESS_DENIED') throw e } } finally { await handle.close() }
      try { const old = await fs.readFile(file, 'utf8'); parseObject(old); await fs.writeFile(file + '.bak.tmp', old, { mode: 0o600 }); await fs.rename(file + '.bak.tmp', file + '.bak') }
      catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError) && e.message !== 'Harus objek JSON') throw e }
      await fs.rename(tmp, file); this.hashes.set(n, hash)
    }
  }) }
  flush() { return this.save() }
}
