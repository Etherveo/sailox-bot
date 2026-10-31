// plugins/owner/diskusage.js
//
// .du — port legacy plugins/owner-diskusage.js: hitung ukuran + jumlah
// file/folder sebuah path secara rekursif.
//
//   .du               -> root project bot
//   .du <path>        -> path relatif terhadap root project
//   .du <file>        -> satu file (files: 1)
//
// Aturan sailox (menyimpang dari legacy yang menerima path apa pun):
// path dijail ke root project, sessions/ ditolak, dan hanya bot utama
// (subbot tidak boleh mengintip disk host). Umpan balik proses memakai
// react ⏳ -> ✅ ala plugin sailox, bukan pesan "Processing" legacy.
//
// Scan async (fs/promises), bukan readdirSync/statSync legacy — supaya
// pohon besar tidak memblokir event loop bot. Symlink dilewati (bukan
// directory maupun file), jadi tidak ada risiko loop — sama seperti
// legacy.
//
// Logika scan tinggal di sini sejak refactor aturan arsitektur
// 2026-10-28 (sebelumnya lib/helpers/diskUsage.js); hanya formatSize
// yang pindah ke utilitas universal lib/helpers/text.js karena dipakai
// juga oleh .clearcache.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatSize } from '#lib/helpers/text.js'
import { reactTo, REACT } from '#lib/helpers/react.js'

export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

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

function projectRoot() {
  const pluginsRoot = global.pluginLoader?.root
  return pluginsRoot ? path.resolve(pluginsRoot, '..') : DEFAULT_ROOT
}

let handler = async (m, { conn, text }) => {
  if (conn?.role === 'sub') throw 'Perintah ini hanya untuk bot utama.'
  await reactTo(m, REACT.processing).catch(() => {})
  try {
    const result = await diskUsage(text, projectRoot())
    await m.reply([
      '📦 *Disk Usage*',
      `\`Path: ${result.path}\`\n`,
      `📊 Size: ${formatSize(result.size)}`,
      `📄 Files: ${result.files}`,
      `📁 Folders: ${result.dirs}`,
    ].join('\n'))
    await reactTo(m, REACT.done).catch(() => {})
  } catch (e) {
    await reactTo(m, REACT.error).catch(() => {})
    throw typeof e === 'string' ? e : e.message
  }
}

handler.help = ['du [path]']
handler.tags = ['owner']
handler.command = /^d(isk)?u(sage)?$/i
handler.owner = true

export default handler
