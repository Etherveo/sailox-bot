// tests/prefix.test.js — .prefix / .cekprefix (prefixless): kedua ejaan
// memicu plugin yang sama, ejaan lain ditolak, balasan menampilkan
// prefix aktif dari global.prefix (string, RegExp, maupun array).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import handler from '../plugins/info/prefix.js'
import { parseCommand } from '../lib/helpers/parsing.js'
import { normalizePlugin } from '../lib/plugins/normalize.js'

const PREFIX = '.!/#$'

test('prefixless (cek)?prefix: prefix dan cekprefix cocok, sisanya tidak', () => {
  for (const input of ['prefix', 'cekprefix', 'Prefix', 'CekPrefix', 'CEKPREFIX']) {
    const parsed = parseCommand(handler, input, PREFIX)
    assert.ok(parsed, `${input} harus cocok`)
    // prefixless menelan seluruh teks sebagai usedPrefix; token perintahnya kosong
    assert.equal(parsed.usedPrefix.toLowerCase(), input.toLowerCase())
    assert.equal(parsed.command, '')
  }
  for (const input of ['cek', 'pre', 'prefixx', 'cekprefixx', 'prefix cek', '.prefix', 'cek prefix']) {
    assert.equal(parseCommand(handler, input, PREFIX), null, `${input} harus ditolak`)
  }
})

test('metadata plugin: help memuat kedua ejaan, normalize mempertahankan prefixless', () => {
  const plugin = normalizePlugin({ default: handler })
  assert.ok(plugin)
  assert.deepEqual(plugin.help, ['cekprefix', 'prefix'])
  assert.equal(plugin.prefixless.source, '^(cek)?prefix$')
})

test('balasan menampilkan prefix aktif (string / RegExp / array)', async () => {
  const previous = global.prefix
  try {
    const replies = []
    const m = { reply: async t => { replies.push(String(t)) } }
    global.prefix = '.!/#$'
    await handler(m, {})
    assert.equal(replies[0], '📍 Prefix aktif saat ini:\n> .!/#$')
    global.prefix = /^[.!]/
    await handler(m, {})
    assert.equal(replies[1], '📍 Prefix aktif saat ini:\n> ^[.!]')
    global.prefix = [/^\./, /^!/]
    await handler(m, {})
    assert.equal(replies[2], '📍 Prefix aktif saat ini:\n> ^\\., ^!')
  } finally {
    global.prefix = previous
  }
})
