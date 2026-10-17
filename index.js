import fs from 'node:fs/promises'
import { watchFile, unwatchFile } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fork, spawn } from 'node:child_process'
import readline from 'node:readline'
import { timingSafeEqual } from 'node:crypto'
import { parseArgs } from 'node:util'
import cfonts from 'cfonts'
import { createHealthServer } from '#lib/helpers/health.js'
import { logger, showLogin, printError } from '#lib/print.js'
const root = path.dirname(fileURLToPath(import.meta.url))
process.chdir(root)
const { values } = parseArgs({ options: { test: { type: 'boolean' }, login: { type: 'string' }, phone: { type: 'string' } }, strict: false })
if (values.test) {
  const child = spawn(process.execPath, [path.join(root, 'test.js')], { stdio: 'inherit' }); child.on('exit', c => { process.exitCode = c ?? 1 })
} else {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  cfonts.say(pkg.name, { font: 'tiny', colors: ['cyan'] }); logger.info(`Author: ${pkg.author}`)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const lines = [], waiters = []; let child, stopping = false, timer, watching = false, reset = false, crashTimes = []
  rl.on('line', line => { const waiter = waiters.shift(); if (waiter) waiter(line); else if (child?.connected) child.send(line); else if (lines.length < 10) lines.push(line) })
  async function gate() {
    if (!process.env.SETUP_PASSWORD) return true
    try { await fs.access(path.join(root, 'sessions/creds.json')); return true } catch (e) { if (e.code !== 'ENOENT') throw e }
    let input = process.env.SETUP_INPUT_PASSWORD
    if (input === undefined) { if (!process.stdin.isTTY) throw new Error('Setup membutuhkan SETUP_INPUT_PASSWORD pada mode noninteraktif'); showLogin('Password setup:'); input = await new Promise(resolve => waiters.push(resolve)) }
    const actual = Buffer.from(input), expected = Buffer.from(process.env.SETUP_PASSWORD)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  let health
  async function stop(signal = 'SIGTERM') {
    if (stopping) return; stopping = true; clearTimeout(timer); unwatchFile(path.join(root, 'main.js')); rl.close(); health?.close()
    if (!child) return
    child.kill(signal)
    const timeout = setTimeout(() => child?.kill('SIGKILL'), 15000)
    child.once('exit', () => { clearTimeout(timeout); process.exit(0) })
  }
  function start() {
    if (stopping) return
    if (watching) { unwatchFile(path.join(root, 'main.js')); watching = false }
    child = fork(path.join(root, 'main.js'), process.argv.slice(2), { cwd: root, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'json' })
    for (const line of lines.splice(0)) child.send(line)
    child.on('message', msg => { if (msg === 'reset') { reset = true; child.kill('SIGTERM') } else if (msg === 'uptime' && child.connected) child.send(process.uptime()) })
    child.on('error', e => printError(e, { module: 'supervisor' }))
    child.once('exit', code => {
      child = null; if (stopping) return
      if (reset) { reset = false; timer = setTimeout(start, 100); return }
      if (code === 0) { watching = true; watchFile(path.join(root, 'main.js'), { interval: 1000 }, (curr, prev) => { if (curr.mtimeMs !== prev.mtimeMs) start() }); return }
      const now = Date.now(); crashTimes = crashTimes.filter(t => now - t < 60000); crashTimes.push(now)
      const delay = crashTimes.length > 5 ? Math.min(300000, 1000 * 2 ** Math.min(crashTimes.length - 5, 16)) : 1000
      logger.warn(`Proses utama keluar. Restart dalam ${delay} ms.`); timer = setTimeout(start, delay)
    })
  }
  process.on('SIGINT', () => stop('SIGINT')); process.on('SIGTERM', () => stop())
  if (!await gate()) { logger.error('Password setup tidak cocok.'); rl.close(); process.exitCode = 1 }
  else {
    health = createHealthServer(); health.on('error', e => { printError(e, { module: 'health' }); stop() }); start()
  }
}
