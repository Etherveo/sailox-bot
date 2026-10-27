// lib/helpers/diskUsage.js
//
// Port legacy plugins/owner-diskusage.js (.du/.diskusage): hitung ukuran +
// jumlah file/folder sebuah path secara rekursif.
//
// Perbedaan vs legacy (disengaja, mengikuti aturan sailox):
// - Path DIJAIL ke root project (fileOps): '..'/symlink yang keluar root
//   ditolak, dan folder sessions/ ditolak total (kredensial akun).
// - Scan ASYNC (fs/promises), bukan readdirSync/statSync legacy — supaya
//   pohon besar tidak memblokir event loop bot.
// - formatSize dijaga dari overflow unit (legacy bisa menghasilkan
//   "undefined" untuk ukuran >= PB karena indeks sizes tak dibatasi).
// - Symlink dilewati (Dirent symlink bukan directory maupun file), jadi
//   tidak ada risiko loop — sama seperti legacy.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const DENY_ALL = new Set(['sessions'])

export function formatSize(bytes = 0) {
  if (!bytes) return '0 B'
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + sizes[i]
}

// Resolusi path + penegakan jail. Mengembalikan path absolut yang aman.
// Target kosong = root project (perilaku legacy: tanpa argumen = cwd bot).
export async function resolveTarget(target, root = DEFAULT_ROOT) {
  const ROOT = path.resolve(root)
  const abs = path.resolve(ROOT, (target ?? '').trim() || '.')
  const rel = path.relative(ROOT, abs)
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Path di luar root project ditolak: ${target}`)
  }
  if (rel.split(path.sep)[0] === 'sessions') {
    throw new Error('Folder sessions/ tidak bisa diakses lewat perintah file (keamanan akun).')
  }
  // Symlink yang menembus keluar root ikut ditolak (cek realpath target
  // yang sudah ada; untuk target baru, cek realpath leluhur terdekatnya).
  let probe = abs
  for (;;) {
    try {
      const real = await fs.realpath(probe)
      const rrel = path.relative(ROOT, real)
      if (rrel === '..' || rrel.startsWith('..' + path.sep) || path.isAbsolute(rrel)) {
        throw new Error(`Path menembus keluar root project (symlink): ${target}`)
      }
      if (rrel.split(path.sep)[0] === 'sessions') {
        throw new Error('Folder sessions/ tidak bisa diakses lewat perintah file (keamanan akun).')
      }
      break
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  return abs
}

// Scan rekursif satu direktori. Item yang gagal dibaca/stat dilewati
// (perilaku legacy: skip error file/dir, bukan gagal total).
export async function scanDir(dirPath) {
  let size = 0
  let files = 0
  let dirs = 0
  let items
  try {
    items = await fs.readdir(dirPath, { withFileTypes: true })
  } catch {
    return { size, files, dirs }
  }
  for (const item of items) {
    const fullPath = path.join(dirPath, item.name)
    try {
      if (item.isDirectory()) {
        dirs++
        const res = await scanDir(fullPath)
        size += res.size
        files += res.files
        dirs += res.dirs
      } else if (item.isFile()) {
        files++
        size += (await fs.stat(fullPath)).size
      }
      // Symlink & tipe lain dilewati (bukan directory/file).
    } catch {
      // skip error file
    }
  }
  return { size, files, dirs }
}

// Satu pintu untuk plugin: resolve + stat + scan. File tunggal -> files 1.
// Target tidak ada -> Error 'Path tidak ditemukan.' (pesan legacy).
export async function diskUsage(target, root = DEFAULT_ROOT) {
  const abs = await resolveTarget(target, root)
  let stat
  try {
    stat = await fs.stat(abs)
  } catch {
    throw new Error('Path tidak ditemukan.')
  }
  const result = stat.isDirectory() ? await scanDir(abs) : { size: stat.size, files: 1, dirs: 0 }
  return { path: abs, isDirectory: stat.isDirectory(), ...result }
}
