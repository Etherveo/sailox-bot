import path from 'node:path'
import { fileOps as defaultOps } from '../../lib/helpers/fileOps.js'
import { getDriveClient } from '../../lib/gdrive/client.js'
import { syncFileToDrive, syncFolderToDrive, defaultTargetFolderId, MAX_UPLOAD_BYTES } from '../../lib/gdrive/sync.js'
import { formatSize } from '../../lib/downloader/runJob.js'

// .uptodrive — port gabungan owner-uptodrive.js + owner-uptodrive2.js
// legacy: unggah file/folder dari disk lokal bot ke Google Drive.
// Dipakai untuk file hasil unduhan yang terlalu besar untuk dikirim
// lewat WhatsApp (>20 MB) — naikkan ke Drive, bagikan link-nya.
//
// Target dipilih dari cwd virtual fileOps yang SAMA dengan yang dipakai
// perintah .ls/.cd owner, jadi alurnya: .cd ke foldernya -> .uptodrive
// untuk melihat isi bernomor -> .uptodrive <nomor|nama|path>.
// Tujuan Drive lain bisa ditunjuk di akhir: .uptodrive 2 : <folderId>
// (pemisah ":" atau "|"). Bawaan: global.gdriveFolderId atau folder
// bawaan legacy. File bernama sama di tujuan dilewati, folder rekursif.

function parseArgs(text = '') {
  const raw = String(text || '').trim()
  const m = raw.match(/^(.*?)\s*(?:\||:)\s*([A-Za-z0-9_-]{10,})\s*$/)
  if (m && m[1].trim()) return { target: m[1].trim(), dest: m[2] }
  return { target: raw, dest: '' }
}

export function formatListing(rel, entries) {
  const lines = [`☁️ *Isi folder:* ${rel === '.' ? '(root project)' : rel}`, '']
  entries.forEach((e, i) => {
    lines.push(`${i + 1}. ${e.type === 'dir' ? '📁' : '📄'} ${e.name}${e.type === 'file' ? ` — ${formatSize(e.size || 0)}` : ''}`)
  })
  lines.push('', 'Unggah: *.uptodrive <nomor|nama|path>*', 'Tujuan lain: *.uptodrive <target> : <folderIdDrive>*')
  return lines.join('\n')
}

let handler = async (m, { conn, text }) => {
  const ops = global.fileOps ?? defaultOps
  const { target, dest: destArg } = parseArgs(text)
  const listing = await ops.fileOp('list')

  if (!target) {
    if (!listing.entries.length) return m.reply('📭 Folder ini kosong.')
    return m.reply(formatListing(listing.rel, listing.entries))
  }

  // Resolusi target: nomor urut (urutan list sama seperti tampilan) atau
  // nama/path yang divalidasi jail fileOps (sessions/ tetap tertolak).
  let abs, st
  if (/^\d+$/.test(target)) {
    const entry = listing.entries[Number(target) - 1]
    if (!entry) throw new Error(`Item nomor ${target} tidak ditemukan di folder ini.`)
    abs = path.join(listing.path, entry.name)
    st = await ops.fileOp('stat', abs)
  } else {
    st = await ops.fileOp('stat', target)
    if (!st.exists) throw new Error(`File/folder tidak ditemukan: ${target}`)
    abs = st.path
  }
  if (st.type !== 'file' && st.type !== 'dir') throw new Error('Target tidak valid (bukan file/folder).')
  if (st.type === 'file' && st.size > MAX_UPLOAD_BYTES) throw new Error('❌ File melebihi batas maksimum 10 GiB.')

  const dest = defaultTargetFolderId(destArg)
  const client = global.uptodriveClient ?? getDriveClient({ rootDir: global.pluginLoader?.root })
  const name = path.basename(abs)

  await m.reply(`☁️ Mengunggah ke Google Drive...\n${st.type === 'dir' ? '📁' : '📄'} ${name}${st.type === 'file' ? ` — ${formatSize(st.size)}` : ''}`)

  if (st.type === 'file') {
    const res = await syncFileToDrive(client, abs, dest)
    if (res.status === 'skipped') return m.reply(`⏭️ Dilewati: ${res.reason}\n📄 ${res.fileName}`)
    return m.reply(
      `✅ *Upload selesai!*\n📄 ${res.fileName} — ${formatSize(res.size)}` +
      (res.webViewLink ? `\n🔗 ${res.webViewLink}` : '')
    )
  }

  const res = await syncFolderToDrive(client, abs, dest)
  return m.reply(
    `✅ *Sinkron folder selesai!*\n📁 ${res.folderName}\n📤 Terunggah: ${res.uploaded}\n⏭️ Dilewati: ${res.skipped}` +
    (res.oversize.length ? `\n⚠️ Terlalu besar (>10 GiB): ${res.oversize.join(', ')}` : '')
  )
}

handler.help = ['uptodrive [nomor|nama|path] [: folderIdDrive]']
handler.tags = ['owner']
handler.command = /^(uptodrive|utd)$/i
handler.owner = true

export default handler
