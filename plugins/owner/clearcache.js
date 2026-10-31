// plugins/owner/clearcache.js
//
// .clearcache — sapu bersih ISI folder provider di src/downloads/.
//
//   .clearcache            daftar provider + cara pakai
//   .clearcache all        kosongkan isi semua folder provider
//   .clearcache <provider> kosongkan isi satu folder provider
//   (boleh beberapa nama sekaligus, pisahkan spasi)
//
// Ini ditulis ulang dari implementasi legacy yang masih memakai peta
// path src/<provider> dan src/public/<provider> lama (sudah tidak ada)
// plus flag publik/force — semuanya dibuang. Prinsip sekarang, sesuai
// ketetapan pemilik: yang dibersihkan HANYA isi folder setiap provider
// di dalam src/downloads/; folder downloads sendiri tidak dikosongkan,
// file lepas di root downloads tidak disentuh, dan folder providernya
// sendiri dipertahankan. Provider yang dibersihkan adalah yang ADA di
// disk, bukan daftar hardcoded — folder provider baru ikut tersapu
// otomatis.
//
// Owner-only. Perhatian: implementasi lama memakai `handler.rowner`
// (typo) yang BUKAN flag izin yang dikenal pipeline — jadi perintah
// ini sebenarnya tidak pernah tergembok. Di sini digembok benar
// dengan handler.owner.
//
// Catatan: jangan dijalankan saat ada unduhan berjalan — folder job
// unduhan aktif tinggal di dalam folder provider dan ikut tersapu.
//
// Sapu bersih ISI folder provider — dan HANYA itu.
//
// Prinsip yang ditetapkan pemilik (menggantikan implementasi legacy):
//   - Targetnya adalah folder setiap provider DI DALAM src/downloads/
//     (gofile, tiktok, ... — apa pun yang ada di disk, bukan daftar
//     hardcoded). Folder downloads sendiri TIDAK dikosongkan, dan file
//     lepas di root downloads TIDAK disentuh.
//   - Folder providernya sendiri DIPERTAHANKAN (hanya isinya yang
//     dihapus), supaya struktur tetap ada dan validator folder provider
//     (ensureProviderDir) tidak perlu bekerja ulang.
//   - Prinsip private/public legacy SUDAH TIDAK DIPAKAI: tidak ada lagi
//     pemisahan src/<provider> vs src/public/<provider>.
//
// Pengaman (jangan dilonggarkan tanpa perintah pemilik):
//   - Nama provider divalidasi (tidak bisa lolos dari folder downloads).
//   - Folder provider yang berupa symlink DITOLAK mentah-mentah —
//     menghapus isi symlink berarti menghapus isi targetnya.
//   - Entri di dalam folder yang berupa symlink hanya menghapus link-nya
//     (lstat, tidak mengikuti target).
//
// Logika sapu tinggal di sini sejak refactor aturan arsitektur
// 2026-10-28 (sebelumnya lib/helpers/clearProviderCache.js).

import fs from 'node:fs/promises'
import path from 'node:path'
import { reactTo, REACT } from '#lib/helpers/react.js'
import { formatSize } from '#lib/helpers/text.js'
import { assertProviderName } from '#lib/helpers/ensureDir.js'

export function downloadsRoot(rootDir) {
  return path.resolve(rootDir, 'src', 'downloads')
}

function assertInside(root, dir) {
  const rel = path.relative(root, dir)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Folder provider di luar folder downloads — ditolak.')
}

// Folder provider yang ADA di disk: subdirektori langsung dari downloads
// (bukan symlink, bukan file). Urut abjad supaya laporan stabil.
export async function listProviderDirs(rootDir) {
  const root = downloadsRoot(rootDir)
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  return entries.filter(e => e.isDirectory()).map(e => e.name).sort()
}

// Ukuran total satu entri (file = ukurannya; folder = rekursif).
// lstat tidak mengikuti symlink, jadi target symlink tidak pernah diukur
// apalagi dihapus.
async function sizeOfEntry(entryPath) {
  const st = await fs.lstat(entryPath)
  if (!st.isDirectory()) return st.size
  let total = 0
  for (const e of await fs.readdir(entryPath)) total += await sizeOfEntry(path.join(entryPath, e))
  return total
}

// Kosongkan ISI satu folder provider. Foldernya sendiri tetap ada.
// Mengembalikan { provider, removed, freedBytes, missing } — missing
// berarti foldernya tidak ada di disk (bukan error).
export async function clearProviderDir(rootDir, provider) {
  const name = assertProviderName(provider)
  const root = downloadsRoot(rootDir)
  const dir = path.join(root, name)
  assertInside(root, dir)
  let st
  try {
    st = await fs.lstat(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return { provider: name, removed: 0, freedBytes: 0, missing: true }
    throw e
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Folder provider bukan direktori biasa: ${name}`)
  const entries = await fs.readdir(dir)
  let removed = 0
  let freedBytes = 0
  for (const entry of entries) {
    const entryPath = path.join(dir, entry)
    freedBytes += await sizeOfEntry(entryPath).catch(() => 0)
    await fs.rm(entryPath, { recursive: true, force: true })
    removed++
  }
  return { provider: name, removed, freedBytes, missing: false }
}

// Kosongkan isi SEMUA folder provider yang ada di disk.
export async function clearAllProviderDirs(rootDir) {
  const providers = await listProviderDirs(rootDir)
  const results = []
  for (const provider of providers) results.push(await clearProviderDir(rootDir, provider))
  return results
}

function projectRoot(ctx) {
  if (global.pluginLoader?.root) return path.resolve(global.pluginLoader.root, '..')
  if (ctx?.__dirname) return path.resolve(ctx.__dirname, '..', '..')
  return process.cwd()
}

let handler = async (m, ctx) => {
  const root = projectRoot(ctx)
  const conn = ctx?.conn ?? m.conn
  const args = (ctx.args ?? []).map(a => String(a).toLowerCase())
  const providers = await listProviderDirs(root)
  const usage = (prefix, command) =>
    `🧹 *Clear Cache*\n\n` +
    `Mengosongkan ISI folder provider di src/downloads/ (folder providernya sendiri tetap ada; file lepas di root downloads tidak disentuh).\n\n` +
    `Pakai: ${prefix}${command} all | <provider>\n` +
    (providers.length ? `\nProvider yang ada:\n${providers.map(p => '• ' + p).join('\n')}` : '\nBelum ada folder provider.')

  if (!args.length) return m.reply(usage(ctx.usedPrefix ?? '.', ctx.command ?? 'clearcache'))

  await reactTo(m, REACT.processing, { conn }).catch(() => {})

  let results
  if (args.length === 1 && args[0] === 'all') {
    results = await clearAllProviderDirs(root)
  } else {
    results = []
    for (const name of [...new Set(args)]) {
      const found = providers.find(p => p.toLowerCase() === name)
      if (!found) {
        results.push({ provider: name, skipped: `tidak ada folder provider '${name}'` })
        continue
      }
      results.push(await clearProviderDir(root, found))
    }
  }

  const cleared = results.filter(r => !r.skipped)
  const skipped = results.filter(r => r.skipped)
  const totalRemoved = cleared.reduce((n, r) => n + r.removed, 0)
  const totalFreed = cleared.reduce((n, r) => n + r.freedBytes, 0)

  let out = `🧹 *Clear Cache Result*\n\n`
  if (cleared.length) {
    out += `✅ Dibersihkan:\n${cleared.map(r => `• ${r.provider} (${r.removed} item, ${formatSize(r.freedBytes)})`).join('\n')}\n` +
      `Total: ${totalRemoved} item, ${formatSize(totalFreed)}\n\n`
  } else {
    out += `Tidak ada yang dibersihkan.\n\n`
  }
  if (skipped.length) out += `⚠️ Dilewati:\n${skipped.map(r => `• ${r.provider} (${r.skipped})`).join('\n')}`

  await reactTo(m, REACT.done, { conn }).catch(() => {})
  await m.reply(out.trim())
}

handler.help = ['clearcache [all|<provider>]']
handler.tags = ['owner']
handler.command = /^(c(lear)?c(ac)?h(e)?)$/i
handler.owner = true

export default handler
