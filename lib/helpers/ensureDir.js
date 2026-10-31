// lib/helpers/ensureDir.js
//
// Satu tempat kanonis untuk "pastikan folder ada": dipakai siapa pun yang
// butuh read/write file (downloader, antrean, engine, fitur lain) supaya
// tidak ada lagi `fs.mkdir(..., { recursive: true })` tersebar yang mudah
// lupa dipanggil sebelum tulis. Idempotent: memanggilnya berkali-kali
// untuk folder yang sudah ada tidak melakukan apa-apa.
import fs from 'node:fs/promises'
import path from 'node:path'

export async function ensureDir(dirPath) {
  if (!dirPath) throw new Error('ensureDir butuh path folder.')
  await fs.mkdir(path.resolve(dirPath), { recursive: true })
  return path.resolve(dirPath)
}

// Validator kanonis folder provider unduhan: SEMUA jalur unduh (runJob,
// .unduh, .tt) wajib lewat sini, bukan merakit
// path.join(root, 'src', 'downloads', provider) sendiri-sendiri —
// supaya tidak ada lagi jalur tulis yang lupa memastikan foldernya.
// Nama provider divalidasi: hanya huruf/angka/titik/dash/underscore
// diawali alfanumerik, jadi tidak mungkin lolos dari folder downloads
// (menolak '..', '/', '\', dan nama diawali titik).
const PROVIDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function assertProviderName(provider) {
  const name = String(provider ?? '').trim()
  if (!PROVIDER_NAME_RE.test(name)) throw new Error(`Nama provider tidak valid: ${provider}`)
  return name
}

export async function ensureProviderDir(rootDir, provider) {
  return ensureDir(path.join(path.resolve(rootDir), 'src', 'downloads', assertProviderName(provider)))
}

export default ensureDir
