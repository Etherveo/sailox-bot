import fs from 'node:fs/promises'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
export async function acquireProcessLock(file) {
  const token = randomUUID(), content = JSON.stringify({ pid: process.pid, host: os.hostname(), token })
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await fs.writeFile(file, content, { flag: 'wx', mode: 0o600 }); return async () => { const current = JSON.parse(await fs.readFile(file, 'utf8')); if (current.token === token) await fs.unlink(file) } }
    catch (e) {
      if (e.code !== 'EEXIST') throw e
      const existing = JSON.parse(await fs.readFile(file, 'utf8'))
      if (existing.host !== os.hostname() || !Number.isInteger(existing.pid) || existing.pid < 1) throw new Error('Lock proses tidak dapat diverifikasi; periksa instance lain')
      try { process.kill(existing.pid, 0); throw new Error('Instance lain masih memegang sesi ini') } catch (alive) { if (alive.code !== 'ESRCH') throw alive }
      await fs.unlink(file)
    }
  }
  throw new Error('Tidak dapat memperoleh lock proses')
}
