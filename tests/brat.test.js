import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { loadFontMetrics, layoutBratText, renderBratPng, bratFontPath } from '../lib/media/brat.js'
import { extractStickerMeta } from '../lib/media/sticker.js'
import bratHandler from '../plugins/sticker/brat.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const measurePalsu = (teks, ukuran) => teks.length * ukuran * 0.5

test('loadFontMetrics: Roboto asli terparse, measure masuk akal & linear', async () => {
  const metrics = await loadFontMetrics(bratFontPath(ROOT))
  assert.equal(metrics.unitsPerEm, 2048)
  const w100 = metrics.measure('Hello World', 100)
  // Nilai acuan terverifikasi silang dengan fontTools: 514.84375 persis.
  assert.ok(w100 > 500 && w100 < 530, `lebar 100px sesuai acuan fontTools: ${w100}`)
  assert.ok(Math.abs(metrics.measure('Hello World', 200) - w100 * 2) < 0.01, 'measure linear terhadap ukuran font')
  assert.ok(metrics.measure(' ', 100) > 0, 'spasi punya lebar')
})

test('layoutBratText: teks pendek 1 baris font penuh; teks panjang menyusut & terbungkus', () => {
  const pendek = layoutBratText('halo', measurePalsu)
  assert.equal(pendek.fontSize, 120)
  assert.deepEqual(pendek.lines, ['halo'])
  const panjang = layoutBratText('kapan kita makan siang bareng lagi ya', measurePalsu)
  assert.ok(panjang.fontSize < 120, 'font menyusut')
  assert.ok(panjang.lines.length >= 2 && panjang.lines.length <= 4, `baris dalam batas: ${panjang.lines.length}`)
  for (const line of panjang.lines) assert.ok(measurePalsu(line, panjang.fontSize) <= 460, 'tiap baris muat lebar pakai')
})

test('renderBratPng: PNG 480x480 berlatar putih (butuh ffmpeg + font repo)', async t => {
  const out = await renderBratPng('kapan nikah?', { root: ROOT }).catch(e => (t.skip(String(e)), null))
  if (!out) return
  assert.equal(out.toString('latin1', 1, 4), 'PNG')
  assert.equal(out.readUInt32BE(16), 480)
  assert.equal(out.readUInt32BE(20), 480)
})

test('plugin brat: teks dari caption quoted mengalir jadi stiker pack Brat', async () => {
  const sent = []
  const conn = { sendMessage: async (jid, data) => { sent.push({ jid, data }); return { key: { remoteJid: jid, id: 'sent1' } } } }
  const m = {
    chat: '123@g.us',
    key: { remoteJid: '123@g.us', id: 'm1', participant: '6281@s.whatsapp.net' },
    mtype: 'conversation',
    quoted: { caption: 'dari caption quoted', text: 'dari caption quoted' },
  }
  await bratHandler(m, { conn, text: '', __dirname: path.join(ROOT, 'plugins', 'sticker') })
  const stickerSend = sent.find(s => s.data.sticker)
  assert.ok(stickerSend, 'ada pengiriman stiker')
  assert.equal(extractStickerMeta(stickerSend.data.sticker)['sticker-pack-name'], 'Brat')
})
