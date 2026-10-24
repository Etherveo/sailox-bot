import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseReplaceArgs, countOccurrences, replaceInPlugins } from '../lib/helpers/pluginReplace.js'

test('parseReplaceArgs: pisah di | pertama, kata baru boleh mengandung |', () => {
  assert.deepEqual(parseReplaceArgs('sailox|ilok'), { oldStr: 'sailox', newStr: 'ilok' })
  assert.deepEqual(parseReplaceArgs(' a | b|c '), { oldStr: 'a', newStr: 'b|c' })
  assert.equal(parseReplaceArgs('tanpa pemisah'), null)
  assert.equal(parseReplaceArgs('|baru'), null)
  assert.equal(parseReplaceArgs('lama|'), null)
  assert.equal(parseReplaceArgs(''), null)
})

test('countOccurrences menghitung kemunculan non-tumpang-tindih', () => {
  assert.equal(countOccurrences('sailox sailox sailox', 'sailox'), 3)
  assert.equal(countOccurrences('tidak ada', 'sailox'), 0)
})

test('replaceInPlugins: rekursif, hitung per file, lewati yang syntax-nya rusak', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-replace-'))
  try {
    await fs.mkdir(path.join(dir, 'group'), { recursive: true })
    await fs.writeFile(path.join(dir, 'a.js'), "export const nama = 'sailox sailox'\n")
    await fs.writeFile(path.join(dir, 'group', 'b.js'), "export const x = 'sailox'\n")
    await fs.writeFile(path.join(dir, 'c.txt'), 'sailox di file teks')
    // 'sailox' -> '123abc' membuat "const 123abc" = syntax error: wajib dilewati.
    await fs.writeFile(path.join(dir, 'rusak.js'), 'const sailox = 1\nexport default sailox\n')
    const { edited, skipped, total } = await replaceInPlugins({ pluginsDir: dir, oldStr: 'sailox', newStr: '123abc' })
    assert.equal(total, 3)
    assert.deepEqual(edited.map(v => v.file), ['a.js', 'group/b.js'])
    assert.deepEqual(skipped.map(v => v.file), ['rusak.js'])
    assert.equal(await fs.readFile(path.join(dir, 'a.js'), 'utf8'), "export const nama = '123abc 123abc'\n")
    assert.match(await fs.readFile(path.join(dir, 'rusak.js'), 'utf8'), /const sailox/, 'file yang dilewati tidak berubah sama sekali')
    assert.equal(await fs.readFile(path.join(dir, 'c.txt'), 'utf8'), 'sailox di file teks', 'file non-.js tidak disentuh')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('replaceInPlugins: tidak ada yang cocok = hasil kosong, tanpa tulisan', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-replace-'))
  try {
    await fs.writeFile(path.join(dir, 'a.js'), 'export const x = 1\n')
    const result = await replaceInPlugins({ pluginsDir: dir, oldStr: 'ngawur', newStr: 'apa' })
    assert.deepEqual(result, { edited: [], skipped: [], total: 0 })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
