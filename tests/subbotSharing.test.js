// tests/subbotSharing.test.js — rantai handler.sharing (2026-11-05):
// normalizePlugin memaksa boolean -> manager mengumpulkan plugin bot
// utama yang sharing = true -> scaffoldSandbox menyalinnya ke sandbox
// sub-bot -> hash sumbernya dipercaya validatePolicyTree di worker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { normalizePlugin } from '../lib/plugins/normalize.js'
import { scaffoldSandbox } from '../lib/subbot/sandbox.js'
import { SubBotManager } from '../lib/subbot/manager.js'
import { codeHash, validatePolicyTree } from '../lib/subbot/policy.js'

async function tmpDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

test('sharing: normalizePlugin memaksa sharing jadi boolean (bawaan false)', () => {
  const fn = () => {}
  assert.equal(normalizePlugin({ default: Object.assign(fn, { sharing: true }) }).sharing, true)
  assert.equal(normalizePlugin({ default: Object.assign(() => {}, {}) }).sharing, false)
  assert.equal(normalizePlugin({ default: Object.assign(() => {}, { sharing: 'yes' }) }).sharing, false)
  // bigSend (opt-in Penjaga Kirim Besar) dinormalisasi dengan pola sama.
  assert.equal(normalizePlugin({ default: Object.assign(() => {}, { bigSend: true }) }).bigSend, true)
  assert.equal(normalizePlugin({ default: Object.assign(() => {}, {}) }).bigSend, false)
})

test('sharing: scaffoldSandbox menyalin plugin sharing ke sandbox; template menang saat bentrok', async t => {
  const botsRoot = await tmpDir(t, 'sailox-share-bots-')
  const templateRoot = await tmpDir(t, 'sailox-share-tpl-')
  const mainRoot = await tmpDir(t, 'sailox-share-main-')
  await fs.mkdir(path.join(templateRoot, 'tools'), { recursive: true })
  await fs.writeFile(path.join(templateRoot, 'tools', 'listplugin.js'), 'TEMPLATE')
  const qrSource = path.join(mainRoot, 'qrcode.js'); await fs.writeFile(qrSource, 'SHARED-QR')
  const lpSource = path.join(mainRoot, 'listplugin.js'); await fs.writeFile(lpSource, 'SHARED-LP')
  const dir = await scaffoldSandbox(botsRoot, 'session@6281234567890', templateRoot, [
    { source: qrSource, id: 'tools/qrcode.js' },
    { source: lpSource, id: 'tools/listplugin.js' },
  ])
  assert.equal(await fs.readFile(path.join(dir, 'plugins', 'tools', 'qrcode.js'), 'utf8'), 'SHARED-QR')
  assert.equal(await fs.readFile(path.join(dir, 'plugins', 'tools', 'listplugin.js'), 'utf8'), 'TEMPLATE', 'bentrok nama: template tidak tertimpa')
})

test('sharing: manager.sharedPluginFiles hanya mengambil plugin bertanda sharing = true', async t => {
  const root = await tmpDir(t, 'sailox-share-root-')
  const manager = Object.create(SubBotManager.prototype)
  manager.root = root
  const prev = global.pluginLoader
  global.pluginLoader = {
    list: () => [
      { id: 'tools/qrcode.js', plugin: { sharing: true } },
      { id: 'tools/ukur.js', plugin: { sharing: false } },
      { id: 'main/menu.js', plugin: {} },
    ],
  }
  try {
    assert.deepEqual(manager.sharedPluginFiles(), [{ id: 'tools/qrcode.js', source: path.join(root, 'plugins', 'tools', 'qrcode.js') }])
  } finally {
    if (prev === undefined) delete global.pluginLoader; else global.pluginLoader = prev
  }
  assert.deepEqual(manager.sharedPluginFiles(), [], 'tanpa loader bot utama, daftarnya kosong')
})

test('sharing: hash plugin sharing dipercaya policy worker walau plugin kustom mati', async t => {
  const root = await tmpDir(t, 'sailox-share-pol-')
  const code = 'let handler = async () => {}\nexport default handler\n'
  await validatePolicyTree({ root, id: 'tools/qrcode.js', code, allowCustomPlugins: false, templateHashes: [codeHash(code)] })
  await assert.rejects(
    validatePolicyTree({ root, id: 'tools/qrcode.js', code, allowCustomPlugins: false, templateHashes: [] }),
    /Plugin kustom dinonaktifkan/)
})
