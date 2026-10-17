import fs from 'node:fs/promises'
import { readFileSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
const startTime = async pid => { try { const s = await fs.readFile(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] } catch { return null } }
const isAlive = async lock => {
  try { process.kill(lock.pid, 0) } catch (e) { if (e.code === 'ESRCH') return false; throw e }
  const now = await startTime(lock.pid)
  return !(lock.start && now && lock.start !== now)
}
export async function acquireProcessLock(file) {
  const token = randomUUID(), content = JSON.stringify({ pid: process.pid, host: os.hostname(), token, start: await startTime(process.pid) })
  const release = async () => { try { const current = JSON.parse(await fs.readFile(file, 'utf8')); if (current.token === token) await fs.unlink(file) } catch (e) { if (e.code !== 'ENOENT') throw e } }
  release.sync = () => { try { const current = JSON.parse(readFileSync(file, 'utf8')); if (current.token === token) unlinkSync(file) } catch {} }
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await fs.writeFile(file, content, { flag: 'wx', mode: 0o600 }); return release }
    catch (e) {
      if (e.code !== 'EEXIST') throw e
      const existing = JSON.parse(await fs.readFile(file, 'utf8'))
      if (existing.host !== os.hostname() || !Number.isInteger(existing.pid) || existing.pid < 1) throw new Error('Lock proses tidak dapat diverifikasi; periksa instance lain')
      if (existing.pid !== process.pid && await isAlive(existing)) throw new Error('Instance lain masih memegang sesi ini')
      await fs.unlink(file)
    }
  }
  throw new Error('Tidak dapat memperoleh lock proses')
}
