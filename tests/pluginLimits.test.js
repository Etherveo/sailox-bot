// tests/pluginLimits.test.js — invarian ekonomi limit:
// setiap plugin command non-owner wajib memasang handler.limit;
// plugin owner/founder/rowner dilarang memasang limit.
// (Aturan Veo 2026-11-25; pengecualian dicatat di setiap tes.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createPluginLoader } from '../lib/plugins/loader.js'

async function load(t) {
  const loader = createPluginLoader({ root: path.resolve('plugins'), publish: false, watch: false, onError: e => { throw e } })
  await loader.load()
  t.after(() => loader.close())
  return loader
}

test('invarian limit: setiap plugin command non-owner memasang handler.limit', async t => {
  const loader = await load(t)
  const missing = []
  for (const { id, plugin } of loader.list()) {
    if (typeof plugin !== 'function') continue
    if (plugin.command == null) continue // hook-only / tanpa command: tidak lewat jalur limit
    if (plugin.owner || plugin.founder || plugin.rowner) continue
    if (id === 'main/register.js') continue // gerbang pendaftaran: user limit 0 tetap harus bisa daftar
    if (plugin.limit === undefined) missing.push(id)
  }
  assert.deepEqual(missing, [], 'plugin command tanpa handler.limit: ' + missing.join(', '))
})

test('invarian limit: plugin owner/founder tidak memasang handler.limit', async t => {
  const loader = await load(t)
  const bad = []
  for (const { id, plugin } of loader.list()) {
    if (typeof plugin !== 'function') continue
    if ((plugin.owner || plugin.founder || plugin.rowner) && plugin.limit !== undefined) bad.push(id)
  }
  assert.deepEqual(bad, [], 'plugin owner dengan handler.limit: ' + bad.join(', '))
})

test('invarian limit: .profile ada dan biaya 1', async t => {
  const loader = await load(t)
  const entry = loader.list().find(({ id }) => id === 'info/profile.js')
  assert.ok(entry, 'plugins/info/profile.js harus ada')
  assert.equal(entry.plugin.limit, true)
  assert.equal(entry.plugin.command.test('profile'), true)
  assert.equal(entry.plugin.command.test('profilex'), false)
})
