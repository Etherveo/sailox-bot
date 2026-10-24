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

export default ensureDir
