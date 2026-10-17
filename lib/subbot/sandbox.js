import fs from 'node:fs/promises'
import path from 'node:path'
export const sessionId = number => { if (!/^\d{7,15}$/.test(number)) throw new Error('Nomor sandbox tidak valid'); return 'session@' + number }
export async function sandboxPath(root, relative = '') {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => p === '..') || relative.includes('\0')) throw new Error('Path sandbox tidak valid')
  root = path.resolve(root); const target = path.resolve(root, relative)
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Path keluar sandbox')
  let cursor = root
  for (const piece of ['', ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
    if (piece) cursor = path.join(cursor, piece)
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Symlink ditolak'); const real = await fs.realpath(cursor); if (real !== root && !real.startsWith(root + path.sep)) throw new Error('Path keluar sandbox') }
    catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  return target
}
export async function scaffoldSandbox(root, id, templateRoot) {
  if (!/^session@\d{7,15}$/.test(id)) throw new Error('ID sandbox tidak valid')
  const dir = await sandboxPath(root, id); await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  for (const d of ['plugins', 'src', 'auth', 'databases', 'tmp']) await fs.mkdir(await sandboxPath(dir, d), { recursive: true, mode: 0o700 })
  if (templateRoot) await copyTemplates(templateRoot, path.join(dir, 'plugins'))
  return dir
}
async function copyTemplates(from, to) {
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    if (e.isSymbolicLink()) throw new Error('Symlink template ditolak')
    const source = path.join(from, e.name), target = await sandboxPath(to, e.name)
    if (e.isDirectory()) { await fs.mkdir(target, { recursive: true }); await copyTemplates(source, target) }
    else if (e.isFile()) { try { await fs.copyFile(source, target, 1) } catch (e) { if (e.code !== 'EEXIST') throw e } }
  }
}
export async function deleteSandbox(root, id) { if (!/^session@\d{7,15}$/.test(id)) throw new Error('ID sandbox tidak valid'); const dir = await sandboxPath(root, id); try { await assertNoSymlinks(dir) } catch (e) { if (e.code !== 'ENOENT') throw e }; await fs.rm(dir, { recursive: true, force: true }) }
export async function assertNoSymlinks(root) { for (const e of await fs.readdir(root, { withFileTypes: true })) { if (e.isSymbolicLink()) throw new Error('Symlink sandbox ditolak'); if (e.isDirectory()) await assertNoSymlinks(path.join(root, e.name)) } }
export async function diskUsage(root) { let bytes = 0; for (const e of await fs.readdir(root, { withFileTypes: true })) { if (e.isSymbolicLink()) throw new Error('Symlink sandbox ditolak'); const p = path.join(root, e.name); bytes += e.isDirectory() ? await diskUsage(p) : (await fs.stat(p)).size } return bytes }
