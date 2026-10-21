// lib/downloader/stream.js
//
// Helper tunggal untuk menulis stream unduhan ke disk, dipakai semua engine
// (di legacy logika pipe ini diduplikasi di tiap engine). Menerima stream
// web (hasil fetch global) maupun stream Node, menghitung byte yang lewat,
// dan membatalkan + menghapus file parsial bila melewati maxBytes atau
// stream-nya error — supaya unduhan gagal tidak meninggalkan file setengah
// jadi dan unduhan liar tidak memenuhi disk.

import fs from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'

export const DEFAULT_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB

export async function streamToFile(body, filePath, { maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES } = {}) {
  if (!body) throw new Error('Stream unduhan kosong.')
  const source = typeof body.getReader === 'function' ? Readable.fromWeb(body) : body
  let bytes = 0
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length
      if (bytes > maxBytes) cb(new Error(`Unduhan melewati batas ukuran (${maxBytes} byte).`))
      else cb(null, chunk)
    }
  })
  try {
    await pipeline(source, counter, fs.createWriteStream(filePath))
  } catch (e) {
    await fs.promises.rm(filePath, { force: true }).catch(() => {})
    throw e
  }
  return bytes
}
