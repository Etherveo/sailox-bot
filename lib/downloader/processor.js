// lib/downloader/processor.js
//
// Pemasangan prosesor antrean unduhan: jembatan antrean (queue.js) ke
// runDownloadJob. Dipakai BERSAMA plugin .download dan .animedownload —
// satu antrean, satu prosesor; pemasangan terakhir (dengan conn
// terbaru) yang menang, sama seperti perilaku semula saat logika ini
// masih tertanam di plugins/downloader/download.js (dipindah verbatim
// pada Fase 3 .animedownload, 2026-11-07, supaya dua permukaan antrean
// tidak memelihara dua salinan kabel yang sama).
//
// Bidang job yang berubah setelah enqueue (khususnya kunci pesan
// posisi antrean) dibaca ulang dari file antrean sesaat sebelum
// diproses, agar prosesor tidak memegang salinan job yang kedaluwarsa.

import { attachDownloadProcessor } from './queue.js'
import { runDownloadJob } from './runJob.js'
import { startBackgroundDriveSync } from './driveSync.js'

export function ensureJobProcessor({ conn, queue, registry, rootDir }) {
  attachDownloadProcessor(async job => {
    let fresh = job
    try {
      const snap = await queue.snapshot()
      const found = snap.jobs.find(j => j.id === job.id)
      if (found) fresh = { ...job, userMsgKey: found.userMsgKey ?? job.userMsgKey, queueNoticeKey: found.queueNoticeKey ?? job.queueNoticeKey }
    } catch { /* pakai salinan job apa adanya */ }
    const getJobState = async id => {
      try { return (await queue.snapshot()).jobs.find(j => j.id === id) ?? null } catch { return null }
    }
    const result = await runDownloadJob({ conn, job: fresh, registry, rootDir, getJobState })
    // Upload Drive latar (.animedownload isUpload=1): hanya sesudah file
    // TERKIRIM ke WA. Sengaja tidak ditunggu — antrean lanjut; hasil
    // upload + nasib file lokal diurus driveSync sendiri.
    if (result?.kind === 'file' && result.sentToWa && fresh.options?.uploadToDrive && result.filePath) {
      void startBackgroundDriveSync({ conn, job: fresh, result, rootDir })
    }
    return result
  })
}
