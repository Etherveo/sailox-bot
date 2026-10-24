import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseSmemeText, drawSmemeText, ffmpegAvailable } from '../lib/media/index.js'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='

test('parseSmemeText: urutan baru atas|bawah, kapital, ukuran bawaan 70', () => {
  assert.deepEqual(parseSmemeText('di atas|gas terus'), { top: 'DI ATAS', bottom: 'GAS TERUS', fontSize: 70 })
  assert.deepEqual(parseSmemeText('cuma bawah'), { top: '', bottom: 'CUMA BAWAH', fontSize: 70 })
  assert.deepEqual(parseSmemeText('cuma atas|'), { top: 'CUMA ATAS', bottom: '', fontSize: 70 })
  assert.equal(parseSmemeText(''), null)
  assert.equal(parseSmemeText('   '), null)
  assert.equal(parseSmemeText('|'), null)
})

test('parseSmemeText: ukuran hanya via sufiks -N (10–120); angka literal aman', () => {
  assert.equal(parseSmemeText('atas|bawah -90').fontSize, 90)
  assert.equal(parseSmemeText('atas|bawah -90').bottom, 'BAWAH')
  assert.equal(parseSmemeText('satu segmen -120').fontSize, 120)
  const literal = parseSmemeText('skor 90|menang 100')
  assert.equal(literal.fontSize, 70)
  assert.equal(literal.top, 'SKOR 90', 'angka literal tanpa tanda - tidak dimakan sebagai ukuran')
  assert.equal(literal.bottom, 'MENANG 100')
  const luar = parseSmemeText('teks -999')
  assert.equal(luar.fontSize, 70)
  assert.equal(luar.bottom, 'TEKS -999', 'sufiks di luar rentang dibiarkan sebagai teks')
  const nempel = parseSmemeText('teks-90')
  assert.equal(nempel.fontSize, 70)
  assert.equal(nempel.bottom, 'TEKS-90', 'tanpa spasi sebelum - bukan sufiks ukuran')
})

test('parseSmemeText: ekspresi drawtext %{ dinetralkan, newline diratakan', () => {
  const parsed = parseSmemeText('halo %{localtime}|dunia\nbaru')
  assert.equal(parsed.top, 'HALO % {LOCALTIME}')
  assert.equal(parsed.bottom, 'DUNIA BARU')
})

test('drawSmemeText: menggambar teks ke PNG (butuh ffmpeg + font asli repo)', async t => {
  if (!await ffmpegAvailable()) return t.skip('ffmpeg tidak tersedia')
  const root = path.resolve(import.meta.dirname, '..')
  const out = await drawSmemeText(Buffer.from(PNG_B64, 'base64'), { root, top: 'ATAS', bottom: 'BAWAH', fontSize: 70 })
  assert.equal(out.toString('latin1', 1, 4), 'PNG')
  assert.ok(out.length > Buffer.from(PNG_B64, 'base64').length, 'hasil lebih besar dari sumber 1x1 polos')
})

test('drawSmemeText: font hilang = error yang jelas', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'smeme-nofont-'))
  try {
    await assert.rejects(() => drawSmemeText(Buffer.from(PNG_B64, 'base64'), { root, bottom: 'X' }), /belum diimpor/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
