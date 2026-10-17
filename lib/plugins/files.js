import fs from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'acorn'
import { randomUUID } from 'node:crypto'
import { sandboxPath } from '../subbot/sandbox.js'
export async function scanPluginFiles(root, relative = '') {
  const dir = await sandboxPath(root, relative), files = []
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    if (e.isSymbolicLink()) throw new Error('Symlink plugin ditolak')
    const id = relative ? relative + '/' + e.name : e.name
    if (e.isDirectory()) files.push(...await scanPluginFiles(root, id))
    else if (e.isFile() && e.name.endsWith('.js')) files.push(id)
  }
  return files.sort()
}
export function pluginName(name) { if (typeof name !== 'string') throw new Error('Nama plugin diperlukan'); name = name.toLowerCase().replace(/\.js$/, ''); if (!/^[a-z0-9_][a-z0-9_-]{0,47}$/.test(name)) throw new Error('Nama plugin tidak valid'); return name }
export async function findPluginFile(root, name) {
  if (typeof name !== 'string' || path.isAbsolute(name) || name.includes('..') || name.includes('\\')) throw new Error('Path plugin tidak valid')
  const tokens = name.replace(/\.js$/i, '').split('/'); if (tokens.length > 2) throw new Error('Gunakan kategori/nama')
  tokens.forEach(pluginName)
  const matches = (await scanPluginFiles(root)).filter(id => tokens.length === 2 ? id.toLowerCase() === tokens.join('/').toLowerCase() + '.js' : path.basename(id, '.js').toLowerCase() === tokens[0].toLowerCase())
  if (matches.length > 1) throw new Error('Nama ambigu; gunakan kategori/nama')
  if (!matches.length) return null
  return { id: matches[0], file: await sandboxPath(root, matches[0]) }
}
export function inspectPlugin(code, maxKB = 512) {
  if (Buffer.isBuffer(code)) code = new TextDecoder('utf-8', { fatal: true }).decode(code)
  if (typeof code !== 'string' || code.includes('\0') || Buffer.byteLength(code) > maxKB * 1024) throw new Error('Kode plugin tidak valid/terlalu besar')
  const ast = parse(code, { sourceType: 'module', ecmaVersion: 'latest', locations: true })
  let tag
  for (const node of ast.body) {
    const e = node.type === 'ExpressionStatement' ? node.expression : null
    const array = e?.type === 'AssignmentExpression' && e.left.type === 'MemberExpression' && e.left.object.name === 'handler' && e.left.property.name === 'tags' ? e.right : node.type === 'ExportNamedDeclaration' ? node.declaration?.declarations?.find(d => d.id.name === 'tags')?.init : null
    if (array?.type === 'ArrayExpression') tag ??= array.elements.find(e => e?.type === 'Literal' && typeof e.value === 'string')?.value
  }
  tag = (tag ?? 'misc').toLowerCase()
  if (!/^[a-z0-9_-]+$/.test(tag) || tag.length > 48) throw new Error('Tag pertama harus slug kategori')
  return { code, ast, tag }
}
export async function savePluginFile({ root, name, code, loader, maxKB = 512, maxPlugins = Infinity, policy }) {
  name = pluginName(name); const inspected = inspectPlugin(code, maxKB)
  await policy?.(inspected.code, inspected.ast)
  const old = await findPluginFile(root, name), all = await scanPluginFiles(root)
  if (!old && all.length >= maxPlugins) throw new Error('Kuota jumlah plugin habis')
  const id = inspected.tag + '/' + name + '.js', target = await sandboxPath(root, id)
  await fs.mkdir(path.dirname(target), { recursive: true }); await sandboxPath(root, id)
  const tmp = path.join(path.dirname(target), '.' + randomUUID() + '.tmp')
  await fs.writeFile(tmp, inspected.code, { mode: 0o600, flag: 'wx' })
  try { await fs.rename(tmp, target) } finally { await fs.rm(tmp, { force: true }) }
  const result = await loader.reload(id)
  if (!result.ok) return { id, ...result }
  if (old && old.id !== id) { await fs.unlink(old.file); await loader.remove(old.id) }
  return { id, ...result, command: String(loader.get(id)?.command ?? 'listener') }
}
export async function deletePluginFile({ root, name, loader }) { const found = await findPluginFile(root, name); if (!found) throw new Error('Plugin tidak ditemukan'); await fs.unlink(found.file); await loader.remove(found.id); try { await fs.rmdir(path.dirname(found.file)) } catch (e) { if (e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST') throw e } return found.id }
