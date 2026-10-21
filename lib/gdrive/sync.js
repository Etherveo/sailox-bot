import fsp from 'node:fs/promises'
import path from 'node:path'

// Logika sinkronisasi lokal -> Drive, port dari legacy
// lib/gdrive-uploader.js & lib/gdrive-uploader-folder.js:
// - File dengan nama yang sama di folder tujuan DILEWATI (tidak ditimpa).
// - Folder disinkronkan REKURSIF (di legacy, syncFolderOneLevel saat ini
//   menunjuk ke syncFolderRecursive; versi satu-levelnya tersimpan
//   sebagai LEGACYsyncFolderOneLevel dan tidak lagi dipakai plugin).
// - Folder tujuan Drive dibuat/diambil otomatis per nama.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024 // 10 GiB, sama seperti konstanta legacy

// Folder tujuan bawaan yang dulu ter-hardcode di plugin legacy.
export const LEGACY_DEFAULT_FOLDER_ID = '1R_JIYXtZehPubsLVYaAxwsmFUxJf0kuw'

export function defaultTargetFolderId(explicit) {
  return String(explicit || globalThis.gdriveFolderId || LEGACY_DEFAULT_FOLDER_ID)
}

export async function syncFileToDrive(client, localFilePath, targetFolderId, { onProgress } = {}) {
  const stat = await fsp.stat(localFilePath).catch(() => null)
  if (!stat?.isFile()) throw new Error(`File lokal tidak ditemukan: ${localFilePath}`)
  const fileName = path.basename(localFilePath)
  if (stat.size > MAX_UPLOAD_BYTES) {
    return { status: 'skipped', reason: 'File melebihi batas maksimum 10 GiB.', fileName, size: stat.size }
  }
  if (!targetFolderId) throw new Error('Folder tujuan Drive belum diatur.')
  const existing = await client.findChildByName(fileName, targetFolderId)
  if (existing) {
    return { status: 'skipped', reason: 'File dengan nama sama sudah ada di folder tujuan.', fileName, id: existing.id, size: stat.size }
  }
  const up = await client.uploadFile(localFilePath, { name: fileName, parentId: targetFolderId, size: stat.size, onProgress })
  return { status: 'uploaded', fileName, id: up.id, webViewLink: up.webViewLink || null, size: stat.size }
}

export async function syncFolderToDrive(client, localFolderPath, targetFolderId, { onProgress } = {}) {
  const stat = await fsp.stat(localFolderPath).catch(() => null)
  if (!stat?.isDirectory()) throw new Error(`Folder lokal tidak ditemukan: ${localFolderPath}`)
  if (!targetFolderId) throw new Error('Folder tujuan Drive belum diatur.')
  const folderName = path.basename(localFolderPath)
  const own = await client.getOrCreateFolder(folderName, targetFolderId)

  let uploaded = 0
  let skipped = 0
  let createdFolders = own.created ? 1 : 0
  const oversize = []

  const entries = await fsp.readdir(localFolderPath, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const full = path.join(localFolderPath, entry.name)
    if (entry.isDirectory()) {
      const res = await syncFolderToDrive(client, full, own.id, { onProgress })
      uploaded += res.uploaded
      skipped += res.skipped
      createdFolders += res.createdFolders
      oversize.push(...res.oversize)
    } else if (entry.isFile()) {
      const res = await syncFileToDrive(client, full, own.id, { onProgress })
      if (res.status === 'uploaded') uploaded++
      else {
        skipped++
        if (/melebihi batas/.test(res.reason || '')) oversize.push(res.fileName)
      }
    }
  }
  return { uploaded, skipped, createdFolders, folderName, folderId: own.id, oversize }
}
