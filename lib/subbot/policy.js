import path from 'node:path'
import { isBuiltin } from 'node:module'
import { parse } from 'acorn'
import fs from 'node:fs/promises'
import { sandboxPath } from './sandbox.js'
import { createHash } from 'node:crypto'
const safeBuiltins = new Set(['path', 'url', 'util', 'crypto', 'buffer', 'stream', 'stream/promises', 'zlib', 'fs', 'fs/promises', 'timers', 'timers/promises', 'events'])
const forbiddenProperties = new Set(['constructor', '__proto__', 'prototype', 'binding', 'dlopen', '_debugProcess', '_linkedBinding', 'mainModule', 'getBuiltinModule', 'env', 'permission', 'execArgv', 'loadEnvFile'])
export function codeHash(code) { return createHash('sha256').update(code).digest('hex') }
export function inspectPolicy(code, { root, allowedPackages = [] } = {}) {
  if (Buffer.isBuffer(code)) code = new TextDecoder('utf-8', { fatal: true }).decode(code)
  if (typeof code !== 'string' || Buffer.byteLength(code) > 512 * 1024 || code.includes('\0')) throw new Error('Kode plugin tidak valid')
  const imports = new Set()
  const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module' })
  function checkImport(source) {
    imports.add(source)
    if (source.includes('\\') || source.split('/').includes('..')) throw new Error('Import keluar sandbox ditolak')
    if (source === '#lib' || source.startsWith('#lib/')) return
    const builtin = source.replace(/^node:/, '')
    if (safeBuiltins.has(builtin)) return
    if (isBuiltin(source)) throw new Error('Import tidak diizinkan: ' + source)
    if (source.startsWith('./') || source.startsWith('../')) {
      if (source.split('/').includes('..') || source.includes('\\') || (root && !path.resolve(root, source).startsWith(path.resolve(root) + path.sep))) throw new Error('Import keluar sandbox ditolak')
      return
    }
    if (allowedPackages.includes(source) && !source.startsWith('node:')) return
    throw new Error('Import tidak diizinkan: ' + source)
  }
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) checkImport(node.source.value)
    if (node.type === 'ImportExpression') { if (node.source.type !== 'Literal' || typeof node.source.value !== 'string') throw new Error('Import dinamis nonliteral ditolak'); checkImport(node.source.value) }
    if (node.type === 'Identifier' && ['eval', 'Function', 'AsyncFunction', 'require', 'createRequire', 'WebAssembly', 'Proxy', 'Reflect'].includes(node.name)) throw new Error('Eksekusi dinamis ditolak')
    if (node.type === 'MemberExpression') {
      if (node.computed && node.property.type !== 'Literal') throw new Error('Akses properti dinamis ditolak oleh policy')
      const prop = node.computed ? node.property.value : node.property.name
      if (forbiddenProperties.has(prop)) throw new Error('Properti berbahaya ditolak: ' + prop)
    }
    if (node.type === 'NewExpression' && node.callee.name === 'RegExp' && !node.arguments.length) throw new Error('Command match-all ditolak pada plugin kustom')
    if (node.type === 'Literal' && node.regex && ['(?:)', ''].includes(node.regex.pattern)) throw new Error('Regex match-all ditolak pada plugin kustom')
    for (const [key, child] of Object.entries(node)) if (key !== 'parent') { if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child) }
  }
  visit(ast)
  return { ok: true, hash: codeHash(code), ast, imports: [...imports] }
}

export async function validatePolicyTree({ root, id, code, allowedPackages = [], maxKB = 64, allowCustomPlugins = false, templateHashes = [], approved = [] }) {
  const seen = new Set()
  async function visit(fileId, source) {
    if (seen.has(fileId)) return
    if (seen.size >= 64) throw new Error('Terlalu banyak dependensi plugin')
    seen.add(fileId)
    const hash = codeHash(source)
    if (templateHashes.includes(hash)) return
    if (allowCustomPlugins === false) throw new Error('Plugin kustom dinonaktifkan')
    if (allowCustomPlugins === 'owner-approval' && !approved.includes(hash)) throw new Error('Plugin/dependensi belum disetujui operator')
    const checked = inspectPolicy(source, { root, allowedPackages })
    for (const spec of checked.imports.filter(s => s.startsWith('.'))) {
      const relative = path.posix.join(path.posix.dirname(fileId), spec)
      if (!relative.endsWith('.js')) throw new Error('Dependensi lokal harus .js')
      const file = await sandboxPath(root, relative)
      if ((await fs.stat(file)).size > maxKB * 1024) throw new Error('Dependensi plugin terlalu besar')
      await visit(relative, await fs.readFile(file, 'utf8'))
    }
  }
  await visit(id, code)
}
