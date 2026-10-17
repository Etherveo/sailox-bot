import fs from 'node:fs/promises'
import path from 'node:path'
export async function ensureDirs(root, sub = false) {
  const dirs = sub ? ['tmp', 'auth', 'databases', 'plugins', 'src'] : ['tmp', 'databases', 'sessions', 'bots', 'src/config', ...['public', 'private'].flatMap(k => ['images', 'videos', 'documents', 'audio', 'others', ...(k === 'private' ? ['URLs', 'JSONs', 'debugs'] : [])].map(v => `src/${k}/${v}`))]
  await Promise.all(dirs.map(d => fs.mkdir(path.join(root, d), { recursive: true, mode: 0o700 })))
}
export async function cleanTmp(root, ageMs = 180000, now = Date.now()) {
  const dir = path.join(root, 'tmp')
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isFile() || e.isSymbolicLink()) continue
    const p = path.join(dir, e.name); const st = await fs.lstat(p)
    if (now - st.mtimeMs > ageMs) await fs.unlink(p)
  }
}
