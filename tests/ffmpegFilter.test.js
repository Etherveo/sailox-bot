import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { escapeFilterPath } from '../lib/media/ffmpegFilter.js'
import { ffmpegAvailable } from '../lib/media/sticker.js'

const execFileP = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('escapeFilterPath: path Windows di-escape untuk string filter ffmpeg', () => {
  // Drive + backslash -> slash + ':' di-escape DOBEL (dua level escaping
  // ffmpeg — satu backslash saja tetap gagal, dibuktikan via execFile).
  assert.equal(escapeFilterPath('C:\\Users\\Public\\font\\Roboto-Regular.ttf'), 'C\\\\:/Users/Public/font/Roboto-Regular.ttf')
  assert.equal(escapeFilterPath('C:\\Users\\irwan\\tmp\\brat-text-1.txt'), 'C\\\\:/Users/irwan/tmp/brat-text-1.txt')
  // Path POSIX tidak berubah sama sekali.
  assert.equal(escapeFilterPath('/home/ryn/bot/src/font/Roboto-Regular.ttf'), '/home/ryn/bot/src/font/Roboto-Regular.ttf')
  assert.equal(escapeFilterPath('/tmp/smeme-text-top.txt'), '/tmp/smeme-text-top.txt')
  // Koma/titik-koma satu backslash; petik dibiarkan mentah (di-escape
  // justru merusak parse — dibuktikan via execFile).
  assert.equal(escapeFilterPath("C:\\font's\\a.ttf"), "C\\\\:/font's/a.ttf")
  assert.equal(escapeFilterPath('C:\\a,b;c.ttf'), 'C\\\\:/a\\,b\\;c.ttf')
})

test('escapeFilterPath: drawtext dengan path font ber-":" lolos parser ffmpeg', async t => {
  // Bukti ujung-ke-ujung: ':' di path (kasus huruf drive Windows) adalah
  // persis yang membuat brat/smeme gagal di laptop Veo. ':' legal di nama
  // file Linux, jadi tes ini menirukan path Windows di VM. Di Windows
  // sendiri direktori bernama 'C:' tidak bisa dibuat — logika escape-nya
  // sudah dikunci tes unit di atas.
  if (process.platform === 'win32') return t.skip('path ber-":" tidak bisa dibuat di Windows')
  if (!await ffmpegAvailable()) return t.skip('ffmpeg tidak tersedia')
  const fontSrc = path.join(ROOT, 'src', 'font', 'Roboto-Regular.ttf')
  if (!await fs.stat(fontSrc).catch(() => null)) return t.skip('font repo belum diimpor')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-ff-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const colonDir = path.join(dir, 'C:')
  await fs.mkdir(colonDir)
  const font = path.join(colonDir, 'Roboto-Regular.ttf')
  await fs.copyFile(fontSrc, font)
  const out = path.join(dir, 'out.png')
  await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=white:s=64x64', '-vf', `drawtext=fontfile=${escapeFilterPath(font)}:text=hi:fontsize=20:fontcolor=black:x=2:y=2`, '-frames:v', '1', out], { timeout: 30000, maxBuffer: 1024 * 1024 })
  assert.ok((await fs.stat(out)).size > 0, 'PNG hasil drawtext harus ada')
})
