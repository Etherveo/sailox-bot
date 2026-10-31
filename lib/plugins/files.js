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
export async function pluginCategories(root) {
  const cats = new Set()
  try { for (const e of await fs.readdir(root, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') cats.add(e.name.toLowerCase()) } catch {}
  for (const id of await scanPluginFiles(root)) { const i = id.indexOf('/'); if (i > 0) cats.add(id.slice(0, i).toLowerCase()) }
  return [...cats].sort()
}
// Parsing target plugin yang "pintar": terima `nama`, `kategori/nama`, atau `kategori-nama`.
// `kategori-nama` dipecah di '-' pertama (kategori boleh baru); tetapi bila sudah ada file
// dengan nama utuh persis sama, file itu yang menang (overwrite/akses di tempatnya).
// Bila kedua tafsir sama-sama ada file-nya dan berbeda, tolak sebagai ambigu.
// Hasil query: string untuk find/delete.
export async function parsePluginTarget(root, raw, { tag } = {}) {
  if (typeof raw !== 'string' || path.isAbsolute(raw) || raw.includes('..') || raw.includes('\\')) throw new Error('Path plugin tidak valid')
  raw = raw.trim().replace(/\.js$/i, '')
  if (!raw) throw new Error('Nama plugin diperlukan')
  if (raw.includes('/')) { const tokens = raw.split('/'); if (tokens.length !== 2) throw new Error('Gunakan kategori/nama'); return { category: pluginName(tokens[0]), name: pluginName(tokens[1]), query: tokens.map(t => pluginName(t)).join('/') } }
  const name = pluginName(raw)
  const found = await findPluginFile(root, name)
  const idx = raw.indexOf('-')
  if (idx > 0) {
    const head = raw.slice(0, idx).toLowerCase(), rest = raw.slice(idx + 1)
    const cats = await pluginCategories(root)
    const catFile = cats.includes(head) ? (await scanPluginFiles(root)).find(id => id.toLowerCase() === `${head}/${rest.toLowerCase()}.js`) : null
    if (found && catFile && catFile !== found.id) throw new Error('Nama ambigu; gunakan kategori/nama')
    // `kategori-nama`: pecah di '-' pertama, simpan hanya sebagai nama.js di folder kategori
    // (kategori boleh baru). Nama utuh yang sudah ada file-nya menang lewat cabang `found` di bawah.
    if (!found) return { category: pluginName(head), name: pluginName(rest), query: `${pluginName(head)}/${pluginName(rest)}` }
  }
  if (found) { const i = found.id.lastIndexOf('/'); return { category: i < 0 ? null : found.id.slice(0, i), name, query: found.id.replace(/\.js$/i, '') } }
  return { category: tag ? pluginName(tag) : null, name, query: name }
}
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
export async function savePluginFile({ root, name, code, loader, maxKB = 512, maxPlugins = Infinity, policy, category }) {
  name = pluginName(name); const inspected = inspectPlugin(code, maxKB)
  await policy?.(inspected.code, inspected.ast)
  // Kategori eksplisit (mis. dari `sp kategori-nama`) mengalahkan tag; tanpa itu folder = tag pertama.
  const targetCategory = category ? pluginName(category) : inspected.tag
  const old = category ? await findPluginFile(root, `${targetCategory}/${name}`) : await findPluginFile(root, name), all = await scanPluginFiles(root)
  if (!old && all.length >= maxPlugins) throw new Error('Kuota jumlah plugin habis')
  const id = targetCategory + '/' + name + '.js', target = await sandboxPath(root, id)
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
