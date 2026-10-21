import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createEngineRegistry } from '../lib/downloader/registry.js'

const goodEngine = `export const id = 'bagus'
export function match(url = '') { return String(url).includes('bagus.test') }
export async function getInfo() { return { fileName: 'b.bin', size: 1 } }
export async function download() { throw new Error('tidak dipakai') }
`

test('registry: file bernama tidak valid dilewati, engine lain tetap termuat (regresi _instatiktok)', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-engines-robust-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const errors = []
  const registry = createEngineRegistry({ dir, onError: e => errors.push(e) })

  await fs.writeFile(path.join(dir, '_draf.js'), goodEngine.replaceAll('bagus', '_draf'))
  await fs.writeFile(path.join(dir, 'bagus.js'), goodEngine)

  await registry.loadAll() // tidak boleh melempar
  assert.equal(registry.has('bagus'), true)
  assert.equal(registry.has('_draf'), false)
  assert.ok(errors.length >= 1, 'kegagalan nama harus dilaporkan via onError')

  const bad = await registry.reload('_draf.js')
  assert.equal(bad.ok, false)
})
