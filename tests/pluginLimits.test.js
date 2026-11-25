// tests/pluginLimits.test.js — invarian ekonomi limit:
// setiap plugin command non-owner wajib memasang handler.limit, KECUALI
// yang ada di daftar bebas Veo; plugin owner/founder/rowner dilarang
// memasang limit. (Aturan Veo 2026-11-25; daftar bebas dicatat di sini
// sebagai allowlist eksplisit per FILE plugin.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createPluginLoader } from '../lib/plugins/loader.js'

// Perintah yang TIDAK makan limit (keputusan Veo 2026-11-25 23:11):
// pay, profile, p (= ping), owner, afk, brb, menu, listkey,
// semua fitur grup, cekprefix, tagme, alarmcheck, timercheck.
// Dicatat per FILE plugin (id loader):
// - listkey (plugins/fun/keyword.js) TIDAK masuk sini karena file-nya
//   owner-only (sudah bebas limit lewat aturan owner, bukan daftar ini).
// - timer/alarm TIDAK masuk sini — file-nya tetap memasang
//   handler.limit (.timer/.alarm tetap bayar); yang bebas hanya
//   subcommand check-nya, lewat m.limit = 0 di dalam handler.
// - cekprefix (plugins/info/prefix.js) satu file dengan 'prefix' —
//   keduanya bebas, karena handler-nya sama dan tidak bisa dipisah.
const FREE_LIMIT_PLUGINS = new Set([
  'info/pay.js',
  'info/profile.js',
  'info/ping.js',
  'info/owner.js',
  'main/afk.js',
  'main/menu.js',
  'tools/tagme.js',
  'info/prefix.js',
  'group/add.js',
  'group/bukatutup.js',
  'group/demote.js',
  'group/delete.js',
  'group/group.js',
  'group/kick.js',
  'group/linkgc.js',
  'group/promote.js',
  'group/setdesc.js',
  'group/setnamagrup.js',
  'group/setppgrup.js',
  'group/swgc.js',
])

async function load(t) {
  const loader = createPluginLoader({ root: path.resolve('plugins'), publish: false, watch: false, onError: e => { throw e } })
  await loader.load()
  t.after(() => loader.close())
  return loader
}

test('invarian limit: setiap plugin command non-owner memasang handler.limit, kecuali daftar bebas Veo', async t => {
  const loader = await load(t)
  const missing = []
  for (const { id, plugin } of loader.list()) {
    if (typeof plugin !== 'function') continue
    if (plugin.command == null) continue // hook-only / tanpa command: tidak lewat jalur limit
    if (plugin.owner || plugin.founder || plugin.rowner) continue
    if (id === 'main/register.js') continue // gerbang pendaftaran: user limit 0 tetap harus bisa daftar
    if (FREE_LIMIT_PLUGINS.has(id)) continue // daftar bebas (keputusan Veo 2026-11-25)
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

test('daftar bebas limit: setiap file di allowlist memang tanpa handler.limit', async t => {
  const loader = await load(t)
  const byId = new Map(loader.list().map(({ id, plugin }) => [id, plugin]))
  for (const id of FREE_LIMIT_PLUGINS) {
    const plugin = byId.get(id)
    assert.ok(plugin, `plugin daftar bebas harus ada: ${id}`)
    assert.equal(plugin.limit, undefined, `${id} harus tanpa handler.limit`)
  }
})

test('invarian limit: .profile ada dan bebas limit', async t => {
  const loader = await load(t)
  const entry = loader.list().find(({ id }) => id === 'info/profile.js')
  assert.ok(entry, 'plugins/info/profile.js harus ada')
  assert.equal(entry.plugin.limit, undefined, '.profile bebas limit (keputusan Veo 2026-11-25)')
  assert.equal(entry.plugin.command.test('profile'), true)
  assert.equal(entry.plugin.command.test('profilex'), false)
})

test('timer/alarm: handler.limit tetap terpasang (.timer/.alarm bayar; check gratis lewat m.limit = 0)', async t => {
  const loader = await load(t)
  for (const id of ['tools/timer.js', 'tools/alarm.js']) {
    const entry = loader.list().find(({ id: x }) => x === id)
    assert.ok(entry, `${id} harus ada`)
    assert.equal(entry.plugin.limit, true, `${id} tetap memasang handler.limit`)
  }
})
