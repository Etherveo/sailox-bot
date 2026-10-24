import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseStickerArgs, assertVideoLimits, addExifToWebp, extractStickerMeta, parseWebpChunks, mediaToSticker, ffmpegAvailable, MAX_VIDEO_BYTES } from '../lib/media/sticker.js'

const execFileP = promisify(execFile)
// WebP 512x512 hasil ffmpeg (VP8X+ALPH+VP8) dan PNG 1x1, fixture tetap.
const WEBP_B64 = 'UklGRj4CAABXRUJQVlA4WAoAAAAQAAAA/wEA/wEAQUxQSBsAAAABBxARERAIJPt7z1BE/zP+85///Oc///nP/wEAVlA4IPwBAABQOgCdASoAAgACPpFIoU0lpCMiIAgAsBIJaW7hd2EbQAnsA99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych6wAAP7/3giqsgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='

test('parseStickerArgs: bawaan, pemisah, dan batas 39 karakter', () => {
  const def = { packname: 'Sailox', author: 'Sailox' }
  assert.deepEqual(parseStickerArgs('', def), def)
  assert.deepEqual(parseStickerArgs('Pack Keren | Veo', def), { packname: 'Pack Keren', author: 'Veo' })
  assert.deepEqual(parseStickerArgs('Pack Saja', def), { packname: 'Pack Saja', author: 'Sailox' })
  assert.deepEqual(parseStickerArgs('| Author Saja', def), { packname: 'Sailox', author: 'Author Saja' })
  assert.deepEqual(parseStickerArgs('a'.repeat(39), def).packname.length, 39)
  assert.throws(() => parseStickerArgs('a'.repeat(40), def), /Pack kepanjangan: 40 karakter/)
  assert.throws(() => parseStickerArgs(`ok | ${'b'.repeat(40)}`, def), /Author kepanjangan: 40 karakter/)
})

test('assertVideoLimits: <10 detik & <=5MB lolos, selebihnya ditolak', () => {
  assert.doesNotThrow(() => assertVideoLimits({ seconds: 9.9, bytes: MAX_VIDEO_BYTES }))
  assert.doesNotThrow(() => assertVideoLimits({ seconds: 0, bytes: 0 }))
  assert.throws(() => assertVideoLimits({ seconds: 10 }), /harus di bawah 10 detik/)
  assert.throws(() => assertVideoLimits({ seconds: 12 }), /harus di bawah 10 detik/)
  assert.throws(() => assertVideoLimits({ bytes: MAX_VIDEO_BYTES + 1 }), /maksimal 5 MB/)
})

test('addExifToWebp: EXIF tertanam & terbaca kembali (jalur VP8X)', () => {
  const webp = Buffer.from(WEBP_B64, 'base64')
  const out = addExifToWebp(webp, { packname: 'Pack Keren', author: 'Veo', packId: 'tes-1' })
  const meta = extractStickerMeta(out)
  assert.equal(meta['sticker-pack-name'], 'Pack Keren')
  assert.equal(meta['sticker-pack-publisher'], 'Veo')
  assert.equal(meta['sticker-pack-id'], 'tes-1')
  assert.equal(out.readUInt32LE(4), out.length - 8, 'ukuran RIFF konsisten dengan panjang file')
  const vp8x = parseWebpChunks(out).find(c => c.tag === 'VP8X')
  assert.ok(vp8x.data[0] & 0x08, 'bendera EXIF di VP8X menyala')
  // Mengganti watermark pada file yang sudah ber-EXIF tidak menggandakan chunk.
  const out2 = addExifToWebp(out, { packname: 'Baru', author: 'Veo', packId: 'tes-2' })
  assert.equal(parseWebpChunks(out2).filter(c => c.tag === 'EXIF').length, 1)
  assert.equal(extractStickerMeta(out2)['sticker-pack-name'], 'Baru')
})

test('addExifToWebp: WebP sederhana tanpa VP8X diberi VP8X baru', () => {
  const webp = Buffer.from(WEBP_B64, 'base64')
  const vp8Only = parseWebpChunks(webp).filter(c => c.tag === 'VP8')
  const body = Buffer.concat([Buffer.from('WEBP'), ...vp8Only.map(c => {
    const head = Buffer.alloc(8); head.write(c.tag); head.writeUInt32LE(c.data.length, 4)
    return Buffer.concat([head, c.data, ...(c.data.length % 2 ? [Buffer.from([0])] : [])])
  })])
  const riff = Buffer.alloc(8); riff.write('RIFF'); riff.writeUInt32LE(body.length, 4)
  const simple = Buffer.concat([riff, body])
  const out = addExifToWebp(simple, { packname: 'P', author: 'A', packId: 'tes-3' }, { width: 512, height: 512 })
  const chunks = parseWebpChunks(out)
  assert.equal(chunks[0].tag, 'VP8X')
  assert.equal(chunks[0].data.readUIntLE(4, 3), 511)
  assert.equal(extractStickerMeta(out)['sticker-pack-name'], 'P')
})

test('mediaToSticker gambar: PNG -> WebP 512 ber-EXIF (butuh ffmpeg)', async t => {
  if (!await ffmpegAvailable()) return t.skip('ffmpeg tidak tersedia')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sticker-tes-'))
  try {
    const out = await mediaToSticker(Buffer.from(PNG_B64, 'base64'), { kind: 'image', root, packname: 'Pack Tes', author: 'Ryn', packId: 'tes-img' })
    assert.equal(out.toString('ascii', 0, 4), 'RIFF')
    assert.equal(extractStickerMeta(out)['sticker-pack-name'], 'Pack Tes')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('mediaToSticker video: 1 detik lolos, 10 detik ditolak oleh ffprobe (butuh ffmpeg)', async t => {
  if (!await ffmpegAvailable()) return t.skip('ffmpeg tidak tersedia')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sticker-tes-'))
  try {
    const mp4 = path.join(root, 'v.mp4')
    await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1:r=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4])
    const buf = await fs.readFile(mp4)
    const out = await mediaToSticker(buf, { kind: 'video', root, packname: 'P', author: 'A', seconds: 0 })
    assert.ok(parseWebpChunks(out).some(c => c.tag === 'ANIM'), 'video menghasilkan WebP animasi')
    await assert.rejects(() => mediaToSticker(buf, { kind: 'video', root, packname: 'P', author: 'A', seconds: 10 }), /di bawah 10 detik/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
