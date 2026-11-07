import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createAnimeNameMap, findMapping, composeFromEntry,
  parseEpisodeLabel, detectResolution, extOf, isEndMarked, sanitizeTitle,
} from '../lib/helpers/animeNameMap.js'

function tempMap(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sailox-animemap-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return createAnimeNameMap({ filePath: path.join(dir, 'anime-map.json') })
}

// ─── store CRUD ──────────────────────────────────────────────────────────────

test('animeMap: add lalu terbaca lagi dari instance baru (persisten)', t => {
  const store = tempMap(t)
  store.add('REDRIVER', { title: 'Sora wa Akai Kawa no Hotori' })
  const again = createAnimeNameMap({ filePath: store.filePath })
  assert.deepEqual(again.get('REDRIVER'), { title: 'Sora wa Akai Kawa no Hotori' })
  assert.equal(again.get('TIDAKADA'), null)
})

test('animeMap: add memangkas field kosong, season/subtitle opsional', t => {
  const store = tempMap(t)
  assert.deepEqual(store.add('K1', { title: ' Judul ', season: ' Season 2 ', subtitle: ' ' }), { title: 'Judul', season: 'Season 2' })
})

test('animeMap: validasi — kunci/title kosong dan edit kunci hilang ditolak', t => {
  const store = tempMap(t)
  assert.throws(() => store.add('  ', { title: 'X' }), /tidak boleh kosong/)
  assert.throws(() => store.add('K', { title: ' ' }), /tidak boleh kosong/)
  assert.throws(() => store.edit('HILANG', { title: 'X' }), /tidak ditemukan/)
})

test('animeMap: edit, editKey (termasuk konflik), remove, clear', t => {
  const store = tempMap(t)
  store.add('AAA', { title: 'Satu' })
  store.add('BBB', { title: 'Dua' })
  store.edit('AAA', { title: 'Satu Baru', season: 'Season 2' })
  assert.deepEqual(store.get('AAA'), { title: 'Satu Baru', season: 'Season 2' })
  assert.throws(() => store.editKey('AAA', 'BBB'), /sudah dipakai/)
  store.editKey('AAA', 'CCC')
  assert.equal(store.get('AAA'), null)
  assert.equal(store.get('CCC').title, 'Satu Baru')
  assert.equal(store.remove('BBB'), true)
  assert.equal(store.remove('BBB'), false)
  store.clear()
  assert.deepEqual(store.list(), {})
})

test('animeMap: file korup melempar error jelas, tidak ditimpa diam-diam', t => {
  const store = tempMap(t)
  fs.writeFileSync(store.filePath, '{ ini bukan json')
  assert.throws(() => store.list(), /rusak/)
  assert.equal(fs.readFileSync(store.filePath, 'utf8'), '{ ini bukan json')
})

// ─── pencocok ────────────────────────────────────────────────────────────────

const MAP = {
  REDRIVER: { title: 'Sora wa Akai Kawa no Hotori' },
  BLCH: { title: 'Bleach (pendek)' },
  BLCH_S2P4: { title: 'Bleach; Sennen Kessen-hen - Kashin-tan' },
}

test('animeMap: kunci cocok sebagai token utuh, case-insensitive', () => {
  assert.equal(findMapping('Kuramanime-REDRIVER-05-720p.mp4', MAP)?.key, 'REDRIVER')
  assert.equal(findMapping('kuramanime-redriver-05.mkv', MAP)?.key, 'REDRIVER')
  assert.equal(findMapping('XREDRIVER-05.mp4', MAP), null, 'menempel di token lain tidak cocok')
  assert.equal(findMapping('REDRIVER2-05.mp4', MAP), null, 'kunci + angka bukan token utuh')
})

test('animeMap: kunci terpanjang didahulukan', () => {
  assert.equal(findMapping('Kuramanime-BLCH_S2P4-13-720p.mp4', MAP)?.key, 'BLCH_S2P4')
})

// ─── potongan nama ───────────────────────────────────────────────────────────

test('animeMap: parseEpisodeLabel — episode, spesial, tanpa label', () => {
  assert.deepEqual(parseEpisodeLabel('Judul - 07 - 720p.mp4'), { kind: 'episode', number: '07', label: 'Episode 07' })
  assert.equal(parseEpisodeLabel('Judul Episode 3.mkv')?.label, 'Episode 03')
  assert.equal(parseEpisodeLabel('Judul-OVA-720p.mp4')?.label, 'OVA')
  assert.equal(parseEpisodeLabel('Judul-Movie.mp4')?.label, 'Movie')
  assert.equal(parseEpisodeLabel('Judul-PV.mp4'), null)
  // angka resolusi bukan episode
  assert.equal(parseEpisodeLabel('Judul-720p.mp4'), null)
})

test('animeMap: detectResolution + extOf', () => {
  assert.equal(detectResolution('Judul-05-720p.mp4'), '720p')
  assert.equal(detectResolution('Judul [1080p].mkv'), '1080p')
  assert.equal(detectResolution('Judul-05.mp4'), null)
  assert.equal(extOf('a/b file.mkv'), '.mkv')
  assert.equal(extOf('tanpa ekstensi'), '')
  assert.equal(extOf('.mp4'), '')
})

// ─── komposer (format 2026-11-07) ────────────────────────────────────────────

test('animeMap: isEndMarked — semua gaya pemisah ketangkap, kata ber-end tidak (bug _end_ Veo 2026-11-07)', () => {
  for (const n of [
    'Kuramanime-TOARU_ALT3-13-end-720p-BGlobal.mp4',
    'Kuramanime-TOARU_ALT3-13_end_720p-BGlobal.mp4',
    'Kuramanime-TOARU_ALT3-13_END_720p-BGlobal.mp4',
    'Judul END.mp4', '[END] Judul - 13.mkv', 'X-13.END.720p.mp4',
  ]) assert.equal(isEndMarked(n), true, n)
  for (const n of [
    'Kuramanime-TOARU_ALT3-13-720p-BGlobal.mp4',
    'X-ENDLESS-01.mp4', 'X-LEGEND-01.mp4', 'X-Weekend-01.mp4',
  ]) assert.equal(isEndMarked(n), false, n)
  // Kasus persis tes live Veo: bentuk underscore kini menghasilkan [END].
  const name = composeFromEntry({ title: 'Toaru Anbu no Item' }, 'Kuramanime-TOARU_ALT3-13_end_720p-BGlobal.mp4')
  assert.equal(name, '[END] Toaru Anbu no Item - Episode 13 Subtitle Indonesia 720p.mp4')
})

test('animeMap: komposer — [NEW] hanya di Episode 01 seri non-sekuel (koreksi Veo 2026-11-07)', () => {
  const first = composeFromEntry({ title: 'Sora wa Akai Kawa no Hotori' }, 'Kuramanime-REDRIVER-01-720p-KuramaBD.mp4')
  assert.equal(first, '[NEW] Sora wa Akai Kawa no Hotori - Episode 01 Subtitle Indonesia 720p.mp4')
  const later = composeFromEntry({ title: 'Sora wa Akai Kawa no Hotori' }, 'Kuramanime-REDRIVER-05-720p-KuramaBD.mp4')
  assert.equal(later, 'Sora wa Akai Kawa no Hotori - Episode 05 Subtitle Indonesia 720p.mp4', 'episode selain 01 tanpa tag')
})

test('animeMap: komposer — sekuel (field season terbaca parser) tanpa [NEW]', () => {
  const name = composeFromEntry({ title: 'Mushoku Tensei', season: 'Season 3' }, 'Kuramanime-MUSHO3-01-1080p.mkv')
  assert.equal(name, 'Mushoku Tensei Season 3 - Episode 01 Subtitle Indonesia 1080p.mkv')
})

test('animeMap: komposer — [END] mengalahkan [NEW]', () => {
  const name = composeFromEntry({ title: 'Sora wa Akai Kawa no Hotori' }, 'Kuramanime-REDRIVER-13-END-720p.mp4')
  assert.equal(name, '[END] Sora wa Akai Kawa no Hotori - Episode 13 Subtitle Indonesia 720p.mp4')
})

test('animeMap: komposer — subtitle entri menggantikan bawaan; tanpa resolusi segmen hilang', () => {
  const name = composeFromEntry({ title: 'Judul Uji', subtitle: 'Subtitle English' }, 'Kuramanime-XXX-02.mkv')
  assert.equal(name, 'Judul Uji - Episode 02 Subtitle English.mkv')
})

test('animeMap: komposer — judul disanitasi gaya npd; tanpa label hasil null', () => {
  const name = composeFromEntry({ title: 'Kimi: Na wa?' }, 'Kuramanime-XXX-01-480p.mp4')
  assert.equal(name, '[NEW] Kimi; Na wa¿ - Episode 01 Subtitle Indonesia 480p.mp4')
  assert.equal(composeFromEntry({ title: 'Apa Pun' }, 'Kuramanime-XXX-PV.mp4'), null)
})

test('animeMap: sanitizeTitle mengikuti tabel normalisasi Veo (2026-11-07)', () => {
  assert.equal(sanitizeTitle('A*B'), 'A_B')
  assert.equal(sanitizeTitle('A/B'), 'A B')
  assert.equal(sanitizeTitle('A:B'), 'A;B')
  assert.equal(sanitizeTitle('A?B'), 'A¿B')
  assert.equal(sanitizeTitle('A\\B'), 'A_B')
  assert.equal(sanitizeTitle('A|B'), 'A_B')
  assert.equal(sanitizeTitle('A<B>C'), 'A_B_C', 'tabu di luar tabel jadi _')
  assert.equal(sanitizeTitle('A\x01B'), 'A_B', 'karakter kontrol jadi _')
  assert.equal(sanitizeTitle('"Satu" dan "Dua"'), '“Satu” dan “Dua”', 'petik dua berpasangan')
  assert.equal(sanitizeTitle('"Gantung'), '“Gantung', 'petik tak berpasangan dianggap pembuka')
  // Judul bersih tidak berubah; entri lama yang sudah disesuaikan manual aman.
  assert.equal(sanitizeTitle('Judul; Bersih ¿Ya”'), 'Judul; Bersih ¿Ya”')
  // Terapan di komposer: judul tabu apa adanya menghasilkan nama aman.
  const name = composeFromEntry({ title: 'Re:Zero "Mulai" *Baru*' }, 'Kuramanime-XXX-01-720p.mp4')
  assert.equal(name, '[NEW] Re;Zero “Mulai” _Baru_ - Episode 01 Subtitle Indonesia 720p.mp4')
})

test('animeMap: resolve ujung-ke-ujung lewat store', t => {
  const store = tempMap(t)
  store.add('REDRIVER', { title: 'Sora wa Akai Kawa no Hotori' })
  const hit = store.resolve('Kuramanime-REDRIVER-05-720p.mp4')
  assert.equal(hit?.key, 'REDRIVER')
  assert.equal(hit?.name, 'Sora wa Akai Kawa no Hotori - Episode 05 Subtitle Indonesia 720p.mp4')
  assert.equal(store.resolve('file acak.mp4'), null)
})
