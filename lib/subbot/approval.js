import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { sandboxPath } from './sandbox.js'
import { inspectPlugin, pluginName } from '../plugins/files.js'
import { codeHash } from './policy.js'
export async function queueApproval(sandbox, name, code, owner) {
  name = pluginName(name); const checked = inspectPlugin(code, global.bots?.maxPluginKB ?? 64)
  const dir = await sandboxPath(sandbox, 'src/plugin-requests'); await fs.mkdir(dir, { recursive: true })
  if ((await fs.readdir(dir)).length >= 20) throw new Error('Maksimal 20 permintaan persetujuan tertunda')
  const id = randomBytes(8).toString('hex'), file = await sandboxPath(sandbox, `src/plugin-requests/${id}.json`)
  await fs.writeFile(file, JSON.stringify({ name, code: checked.code, hash: codeHash(checked.code), owner, at: Date.now() }), { flag: 'wx', mode: 0o600 }); return id
}
export async function readApproval(sandbox, id, maxKB) {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('ID persetujuan tidak valid')
  const file = await sandboxPath(sandbox, `src/plugin-requests/${id}.json`)
  if ((await fs.stat(file)).size > maxKB * 1024 * 2) throw new Error('Permintaan terlalu besar')
  const data = JSON.parse(await fs.readFile(file, 'utf8')); pluginName(data.name); inspectPlugin(data.code, maxKB)
  if (codeHash(data.code) !== data.hash) throw new Error('Hash permintaan tidak cocok')
  return { ...data, file }
}
