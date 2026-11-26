// tests/parsing.test.js — parseCommand: batas 128 kata default, dan
// handler.maxArgs menaikkan batas untuk perintah berteks panjang (.bcc).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand } from '../lib/helpers/parsing.js'

const plugin = { command: ['bcc', 'broadcastchannel'] }
const words = n => 'x '.repeat(n).trim()

test('parseCommand: 128 kata lolos, 129 kata ditolak diam-diam', () => {
  assert.ok(parseCommand(plugin, '.bcc ' + words(128), '.'))
  assert.equal(parseCommand(plugin, '.bcc ' + words(129), '.'), null)
})

test('parseCommand: maxArgs menaikkan batas (pengumuman .bcc 144 kata)', () => {
  const parsed = parseCommand({ ...plugin, maxArgs: 2000 }, '.bcc ' + words(144), '.')
  assert.ok(parsed, 'teks siaran panjang harus terurai')
  assert.equal(parsed.text.split(/\s+/).length, 144)
  assert.equal(parseCommand({ ...plugin, maxArgs: 2000 }, '.bcc ' + words(2001), '.'), null)
})
