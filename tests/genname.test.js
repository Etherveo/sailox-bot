// tests/genname.test.js — plugin .genname (plugins/tools/genname.js):
// generator nama human-readable berbasis pola V/C dari generateSSIDs
// legacy fun-hack.js + mode username dari fun-hackemail.js. Semua tes
// memakai RNG ber-seed supaya deterministik.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import handler, {
  parseGennameArgs,
  randomPattern,
  mutatePattern,
  makeWordFromPattern,
  leetNumberize,
  generateName,
  generateNames,
} from '../plugins/tools/genname.js'

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const zero = () => 0
const nearOne = () => 0.99

test('parseGennameArgs: bawaan tanpa argumen', () => {
  assert.deepEqual(parseGennameArgs(''), { ok: true, words: null, count: 1, num: false, mode: 'base' })
  assert.deepEqual(parseGennameArgs('   '), { ok: true, words: null, count: 1, num: false, mode: 'base' })
})

test('parseGennameArgs: angka polos, n<angka>, num, mode — urutan bebas', () => {
  const expected = { ok: true, words: 3, count: 5, num: true, mode: 'base' }
  assert.deepEqual(parseGennameArgs('3 n5 num'), expected)
  assert.deepEqual(parseGennameArgs('num n5 3'), expected)
  assert.deepEqual(parseGennameArgs('-ssid'), { ok: true, words: null, count: 1, num: false, mode: 'ssid' })
  assert.deepEqual(parseGennameArgs('-user 2'), { ok: true, words: 2, count: 1, num: false, mode: 'user' })
})

test('parseGennameArgs: clamp jumlah kata 1–6 dan jumlah nama 1–10', () => {
  assert.equal(parseGennameArgs('7').words, 6)
  assert.equal(parseGennameArgs('99').words, 6)
  assert.equal(parseGennameArgs('0').words, 1)
  assert.equal(parseGennameArgs('n10').count, 10)
  assert.equal(parseGennameArgs('n99').count, 10)
  assert.equal(parseGennameArgs('n0').count, 1)
})

test('parseGennameArgs: nilai pertama menang; token asing ditolak', () => {
  assert.equal(parseGennameArgs('2 5').words, 2)
  assert.equal(parseGennameArgs('n2 n7').count, 2)
  assert.equal(parseGennameArgs('-user -ssid').mode, 'user')
  assert.equal(parseGennameArgs('halo').ok, false)
  assert.equal(parseGennameArgs('-xyz').ok, false)
  assert.equal(parseGennameArgs('3 kata').ok, false)
})

test('randomPattern: 3–6 segmen, selang-seling ketat, memuat V dan C', () => {
  const rng = mulberry32(42)
  for (let i = 0; i < 200; i++) {
    const p = randomPattern(rng)
    assert.ok(p.length >= 3 && p.length <= 6, `panjang ${p.length}`)
    assert.ok(p.includes('V') && p.includes('C'))
    assert.ok(!/VV|CC/.test(p.join('')), `segmen sejenis berdampingan di ${p.join('')}`)
  }
})

test('randomPattern: jejak deterministik rng ekstrem (selang-seling ketat)', () => {
  assert.deepEqual(randomPattern(zero), ['C', 'V', 'C'])
  assert.deepEqual(randomPattern(nearOne), ['V', 'C', 'V', 'C', 'V', 'C'])
})

test('makeWordFromPattern: mengisi slot V/C dan Title Case', () => {
  assert.equal(makeWordFromPattern(['C', 'V', 'C', 'V'], zero), 'Baba')
  assert.equal(makeWordFromPattern(['V', 'C'], zero), 'Aba') // vokal penutup 35% ikut karena rng 0
  const rng = mulberry32(7)
  for (let i = 0; i < 50; i++) {
    const w = makeWordFromPattern(randomPattern(rng), rng)
    assert.match(w, /^[A-Z][a-z]+$/)
    assert.match(w, /[aiueoAIUEO]/)
  }
})

test('mutatePattern: salinan pola; mutasi menjaga selang-seling', () => {
  const base = ['C', 'V', 'C', 'V']
  const untouched = mutatePattern(base, 1, nearOne)
  assert.deepEqual(untouched, base)
  assert.notEqual(untouched, base) // salinan, bukan referensi yang sama
  assert.deepEqual(base, ['C', 'V', 'C', 'V']) // pola asal tidak berubah
  const seq = (...vals) => { let i = 0; return () => vals[Math.min(i++, vals.length - 1)] }
  // tambah segmen: hanya markah lawan dari segmen terakhir
  assert.deepEqual(mutatePattern(['C', 'V', 'C'], 1, seq(0, 0.99)), ['C', 'V', 'C', 'V'])
  // balik urutan: ritme cermin (pola 6 segmen tidak bisa ditambah lagi)
  assert.deepEqual(mutatePattern(['C', 'V', 'C', 'V', 'C', 'V'], 1, zero), ['V', 'C', 'V', 'C', 'V', 'C'])
})

test('kualitas tuning: tidak ada run huruf konsonan >= 4 di nama dasar', () => {
  const names = generateNames({ words: null, count: 40, mode: 'base', num: false }, mulberry32(99))
  assert.equal(names.length, 40)
  for (const name of names) {
    for (const w of name.split(' ')) assert.ok(!/[bcdfghjklmnpqrstvwyz]{4,}/i.test(w), `run konsonan di "${w}"`)
  }
})

test('leetNumberize: a→4 i→1 g→9 o→0, probabilistik + jaminan minimal satu', () => {
  assert.equal(leetNumberize('gi', zero), '91')
  assert.equal(leetNumberize('bcd', zero), 'bcd') // tidak ada huruf yang bisa diganti
  assert.equal(leetNumberize('nama', nearOne), 'n4ma') // rng menolak semua → huruf pertama dipaksa
  assert.equal(leetNumberize('xyz', nearOne), 'xyz')
})

test('generateNames mode dasar: jumlah kata tetap, unik, tanpa angka', () => {
  const names = generateNames({ words: 3, count: 5, mode: 'base', num: false }, mulberry32(11))
  assert.equal(names.length, 5)
  assert.equal(new Set(names).size, 5)
  for (const name of names) {
    const words = name.split(' ')
    assert.equal(words.length, 3)
    for (const w of words) assert.match(w, /^[A-Z][a-z]+$/)
    assert.ok(!/\d/.test(name))
  }
})

test('generateNames mode dasar: jumlah kata bawaan acak 2–4', () => {
  const names = generateNames({ words: null, count: 8, mode: 'base', num: false }, mulberry32(23))
  assert.equal(names.length, 8)
  for (const name of names) {
    const n = name.split(' ').length
    assert.ok(n >= 2 && n <= 4, `jumlah kata ${n}`)
  }
})

test('generateNames mode dasar + num: setiap nama mengandung angka', () => {
  const names = generateNames({ words: 3, count: 4, mode: 'base', num: true }, mulberry32(31))
  assert.equal(names.length, 4)
  for (const name of names) assert.match(name, /\d/)
})

test('generateName mode user: kataSifat_kataBenda + angka ekor, huruf kecil', () => {
  const rng = mulberry32(5)
  for (let i = 0; i < 20; i++) {
    const name = generateName({ mode: 'user', num: false }, rng)
    assert.match(name, /^[a-z]+_[a-z]+\d{2,4}$/)
  }
  const withNum = generateName({ mode: 'user', num: true }, mulberry32(6))
  assert.match(withNum, /^[a-z0-9]+_[a-z0-9]+\d{2,4}$/)
})

test('generateNames mode ssid: panjang maksimal 25 dan unik; +num selalu berangka', () => {
  const names = generateNames({ words: 6, count: 8, mode: 'ssid', num: false }, mulberry32(77))
  assert.equal(names.length, 8)
  for (const name of names) assert.ok(name.length <= 25, `"${name}" kepanjangan`)
  const numbered = generateNames({ words: 3, count: 4, mode: 'ssid', num: true }, mulberry32(78))
  assert.equal(numbered.length, 4)
  for (const name of numbered) assert.match(name, /\d/)
})

test('handler: membalas nama; token asing → usage dilempar', async () => {
  const sent = []
  const m = { reply: async t => { sent.push(t) } }
  await handler(m, { text: '2 n2', usedPrefix: '.', command: 'genname' })
  assert.equal(sent.length, 1)
  const lines = sent[0].split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^1\. /)
  assert.match(lines[1], /^2\. /)
  await assert.rejects(
    handler(m, { text: 'ngawur', usedPrefix: '.', command: 'genname' }),
    /Contoh penggunaan/
  )
})
