import fs from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'acorn'
import { spawn } from 'node:child_process'
async function scan(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || ['node_modules', 'bots', 'sessions', 'databases', 'tmp'].includes(e.name)) continue
    const file = path.join(dir, e.name)
    if (e.isDirectory()) await scan(file)
    else if (file.endsWith('.js')) { try { parse(await fs.readFile(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' }) } catch (e) { throw new Error(file + ': ' + e.message, { cause: e }) } }
  }
}
await scan('.')
const child = spawn(process.execPath, ['--test', ...(await fs.readdir('tests')).filter(n => n.endsWith('.test.js')).map(n => 'tests/' + n)], { stdio: 'inherit' })
child.on('error', err => { process.stderr.write(err.message + '\n'); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
