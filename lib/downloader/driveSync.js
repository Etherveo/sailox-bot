// lib/downloader/driveSync.js
//
// Upload Drive LATAR untuk job antrean bertanda uploadToDrive (saat ini:
// .animedownload isUpload=1, Fase 4). Dipanggil prosesor antrean
// (processor.js) TANPA ditunggu sesudah runDownloadJob menyatakan file
// terkirim ke WA — antrean tidak pernah tertahan oleh upload.
//
// Nasib file lokal (Keputusan Fase 0 butir 4): urutan kirim WA -> upload
// -> hapus, dan penghapusan HANYA bila kedua langkah sukses. "Sukses"
// mencakup file yang ternyata sudah ada di Drive (syncFileToDrive
// melewatinya sebagai skipped + id file yang ada): Drive sudah
// memegang salinannya, jadi salinan lokal boleh dibuang. Skipped TANPA
// id (mis. melewati batas 10 GiB) bukan sukses — file dipertahankan.
// Kegagalan upload: error dilaporkan MENTAH ke chat peminta (standar
// error downloader) + log terminal, file tidak pernah dihapus.

import fsp from 'node:fs/promises'
import path from 'node:path'
import { getDriveClient } from '../gdrive/client.js'
import { syncFileToDrive, defaultTargetFolderId } from '../gdrive/sync.js'
import { formatSize } from './runJob.js'

const defaultDeps = {
  // Pola yang sama seperti plugins/anime/pilih.js & owner/uptodrive.js:
  // klien bisa diinjeksi lewat globalThis (dipakai pengujian).
  getClient: rootDir => globalThis.uptodriveClient ?? getDriveClient({ rootDir }),
  syncFile: syncFileToDrive,
  folderId: () => defaultTargetFolderId(),
}

// Tidak pernah melempar: semua kegagalan berakhir sebagai laporan.
// Mengembalikan promise-nya supaya pengujian bisa menunggu selesai.
export function startBackgroundDriveSync({ conn, job, result, rootDir, deps } = {}) {
  const d = { ...defaultDeps, ...(deps ?? {}) }
  const jobDir = result?.filePath ? path.dirname(result.filePath) : null
  const done = (async () => {
    try {
      const client = await d.getClient(rootDir)
      const res = await d.syncFile(client, result.filePath, d.folderId())
      if (res?.status === 'uploaded' || (res?.status === 'skipped' && res?.id)) {
        // WA terkirim + Drive memegang file -> salinan lokal dibuang.
        if (jobDir) await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {})
        await conn.sendMessage(job.chat, {
          text: `☁️ *Upload Drive selesai* — antrean #${job.id}\n📄 ${result.fileName}\n📏 ${formatSize(result.size)}` +
            (res.status === 'skipped' ? `\nℹ️ File ternyata sudah ada di Drive — duplikat dilewati, salinan lokal dibersihkan.` : '') +
            (res.webViewLink ? `\n🔗 ${res.webViewLink}` : '') +
            `\n🗑️ Salinan lokal dihapus (kirim WA + upload sama-sama sukses).`,
        }).catch(() => {})
        return
      }
      // Skipped tanpa id = tidak terunggah (mis. > 10 GiB): pertahankan.
      await conn.sendMessage(job.chat, {
        text: `⚠️ *File tidak diunggah ke Drive* — antrean #${job.id}\n📄 ${result.fileName}\n${res?.reason ?? 'Alasan tidak diketahui.'}\n📁 File tetap disimpan lokal: ${result.relPath}`,
      }).catch(() => {})
    } catch (e) {
      console.error(`[driveSync] upload Drive job #${job?.id} (${result?.fileName}) gagal:`, e)
      await conn.sendMessage(job.chat, {
        text: `⚠️ *Upload Drive gagal* — antrean #${job.id}\n📄 ${result.fileName}\n${e?.message || e}\n📁 File tetap disimpan lokal: ${result.relPath}`,
      }).catch(() => {})
    }
  })()
  return done.catch(() => {})
}
