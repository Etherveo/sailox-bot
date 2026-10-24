import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Database } from '../lib/database/engine.js'
import { applyStoredConfig, setConfig, deleteConfig, listConfig, coerceConfigValue } from '../lib/helpers/configStore.js'
import { configCommand } from '../lib/helpers/configCommands.js'
import configHandler from '../plugins/owner/config.js'

const GLOBAL_KEYS = ['logPrivacy', 'bots', 'prefix', 'defaultLimit']
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-config-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const saved = Object.fromEntries(GLOBAL_KEYS.map(k => [k, globalThis[k]]))
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v } delete globalThis.db })
  globalThis.logPrivacy = 'masked'
  globalThis.prefix = '.'
  globalThis.defaultLimit = 100
  globalThis.bots = { enabled: false, allowCustomPlugins: false, maxBots: 5, allowedPackages: [] }
  const db = await new Database({ dir: path.join(dir, 'databases') }).load()
  globalThis.db = db
  return { dir, db }
}
function fakeM() { const replies = []; return { replies, reply: async teks => { replies.push(String(teks)) } } }
const ctx = text => ({ text, args: text ? text.split(/\s+/) : [] })

test('plugin config khusus founder dan terdaftar sebagai command config/cfg', () => {
  assert.equal(configHandler.founder, true)
  assert.deepEqual(configHandler.command, ['config', 'cfg'])
})

test('coerce: boolean, int + rentang, enum, pluginPolicy, list, timezone, prefix', () => {
  assert.equal(coerceConfigValue('bots.enabled', 'on'), true)
  assert.equal(coerceConfigValue('bots.enabled', 'off'), false)
  assert.throws(() => coerceConfigValue('bots.enabled', 'mungkin'), /boolean/)
  assert.equal(coerceConfigValue('defaultLimit', '250'), 250)
  assert.throws(() => coerceConfigValue('defaultLimit', '-1'), /antara/)
  assert.throws(() => coerceConfigValue('defaultLimit', 'abc'), /bilangan bulat/)
  assert.equal(coerceConfigValue('logPrivacy', 'full'), 'full')
  assert.throws(() => coerceConfigValue('logPrivacy', 'semua'), /salah satu/)
  assert.equal(coerceConfigValue('bots.allowCustomPlugins', 'owner-approval'), 'owner-approval')
  assert.equal(coerceConfigValue('bots.allowCustomPlugins', 'true'), true)
  assert.equal(coerceConfigValue('bots.allowCustomPlugins', 'false'), false)
  assert.deepEqual(coerceConfigValue('bots.allowedPackages', 'axios, lodash'), ['axios', 'lodash'])
  assert.throws(() => coerceConfigValue('bots.allowedPackages', 'paket jahat!'), /tidak valid/)
  assert.equal(coerceConfigValue('timezone', 'Asia/Makassar'), 'Asia/Makassar')
  assert.throws(() => coerceConfigValue('timezone', 'Mars/Olympus'), /tidak dikenal/)
  assert.throws(() => coerceConfigValue('kunciNgawur', 'x'), /tidak dikenal/)
})

test('set tersimpan ke databases/config.json, langsung berlaku, dan objek bots tidak diganti (referensi manager aman)', async t => {
  const { dir, db } = await setup(t)
  const botsRef = globalThis.bots
  applyStoredConfig(db)
  const r = await setConfig(db, 'logPrivacy', 'full')
  assert.equal(r.previous, 'masked')
  assert.equal(globalThis.logPrivacy, 'full')
  await setConfig(db, 'bots.enabled', 'on')
  await setConfig(db, 'bots.allowCustomPlugins', 'owner-approval')
  assert.equal(globalThis.bots, botsRef, 'global.bots harus objek yang sama')
  assert.equal(botsRef.enabled, true)
  assert.equal(botsRef.allowCustomPlugins, 'owner-approval')
  const file = JSON.parse(await fs.readFile(path.join(dir, 'databases/config.json'), 'utf8'))
  assert.equal(file.global.logPrivacy, 'full')
  assert.equal(file.global.bots.enabled, true)
  // proses baru: muat ulang dari disk dan terapkan -> nilai bertahan
  const db2 = await new Database({ dir: path.join(dir, 'databases') }).load()
  globalThis.logPrivacy = 'masked'; globalThis.bots.enabled = false
  const applied = applyStoredConfig(db2)
  assert.ok(applied.includes('logPrivacy') && applied.includes('bots.enabled'))
  assert.equal(globalThis.logPrivacy, 'full')
  assert.equal(globalThis.bots.enabled, true)
})

test('del menghapus override dan mengembalikan nilai default config.js saat itu juga', async t => {
  const { db } = await setup(t)
  applyStoredConfig(db)
  await setConfig(db, 'logPrivacy', 'full')
  assert.equal(globalThis.logPrivacy, 'full')
  const { restored } = await deleteConfig(db, 'logPrivacy')
  assert.equal(restored, 'masked')
  assert.equal(globalThis.logPrivacy, 'masked')
  await assert.rejects(deleteConfig(db, 'logPrivacy'), /Tidak ada override/)
  const rows = listConfig(db)
  assert.equal(rows.find(r => r.key === 'logPrivacy').stored, false)
})

test('perintah .config: list/get/set/del lewat handler', async t => {
  const { db } = await setup(t)
  applyStoredConfig(db)
  const m = fakeM()
  await configCommand(m, ctx('set logPrivacy full'))
  assert.match(m.replies.at(-1), /logPrivacy/)
  assert.match(m.replies.at(-1), /masked → full/)
  assert.equal(globalThis.logPrivacy, 'full')
  const m2 = fakeM()
  await configCommand(m2, ctx('get logPrivacy'))
  assert.match(m2.replies.at(-1), /logPrivacy = full/)
  assert.match(m2.replies.at(-1), /config\.json/)
  const m3 = fakeM()
  await configCommand(m3, ctx('list'))
  assert.match(m3.replies.at(-1), /bots\.allowCustomPlugins/)
  assert.match(m3.replies.at(-1), /logPrivacy = full \(json\)/)
  const m4 = fakeM()
  await configCommand(m4, ctx('del logPrivacy'))
  assert.equal(globalThis.logPrivacy, 'masked')
  await assert.rejects(configCommand(fakeM(), ctx('set logPrivacy')), /Nilai kosong/)
  await assert.rejects(configCommand(fakeM(), ctx('set apikey rahasia')), /tidak dikenal/)
})

test('coerce: toggle trigger chat Ryn boolean', () => {
  assert.equal(coerceConfigValue('rynTriggerReply', 'on'), true)
  assert.equal(coerceConfigValue('rynTriggerReply', 'off'), false)
  assert.equal(coerceConfigValue('rynTriggerMention', 'off'), false)
  assert.throws(() => coerceConfigValue('rynTriggerMention', 'kadang'), /boolean/)
})

test('coerce: kunci chat Ryn — rynScope/rynUsers enum, rynGroups list JID', () => {
  assert.equal(coerceConfigValue('rynScope', 'both'), 'both')
  assert.equal(coerceConfigValue('rynScope', 'group'), 'group')
  assert.throws(() => coerceConfigValue('rynScope', 'semua'), /salah satu/)
  assert.equal(coerceConfigValue('rynUsers', 'founder'), 'founder')
  assert.equal(coerceConfigValue('rynUsers', 'anyone'), 'anyone')
  assert.throws(() => coerceConfigValue('rynUsers', 'admin'), /salah satu/)
  assert.deepEqual(coerceConfigValue('rynGroups', '120363111@g.us, 120363222@g.us'), ['120363111@g.us', '120363222@g.us'])
  assert.deepEqual(coerceConfigValue('rynGroups', ''), [])
  assert.throws(() => coerceConfigValue('rynGroups', 'bukan-jid'), /JID grup tidak valid/)
})
