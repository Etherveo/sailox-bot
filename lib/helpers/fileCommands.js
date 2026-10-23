import path from 'node:path'
import { fileOps as defaultOps } from './fileOps.js'

// Perintah file system KHUSUS owner bot utama — migrasi dari plugin legacy
// owner-cd/readfile/editfile/getfile/createdir/deldir/cleandir/copyfile/
// movefile/copydirektori/renamefolder/carifile. Semua operasi berkas lewat
// SATU helper global fileOps (lib/helpers/fileOps.js); modul ini hanya
// mengurus parsing format chat, validasi bentuk target, dan format balasan.
//
// Perbedaan sadar dari legacy (demi keamanan engine sekarang):
// - Path dikurung di root project + folder sessions/ ditolak total (legacy
//   bebas ke seluruh filesystem; di sini sesi = kredensial akun, tidak boleh
//   dibaca/dikirim ke chat — AGENTS.md 4.2).
// - Posisi "cwd" disimpan instance fileOps (dulu global.cwdPath), tetap
//   in-memory dan kembali ke root project setiap bot restart.
// - copyfile/copydir/mv sekarang menolak menimpa tujuan yang sudah ada
//   (legacy copyfile menimpa diam-diam); renamefolder me-rename di tempat
//   (legacy selalu memindah ke cwd).
// - readfile2 legacy adalah duplikat readfile, tidak dimigrasikan terpisah.
// - ls tidak ada di legacy (hanya disebut peminta) — dibuat di sini memakai
//   urutan list() yang sama dengan resolusi nomor urut copy/move.
const TEXT_AS_DOCUMENT_OVER = 60000
const MAX_GETFILE_BYTES = 150 * 1024 * 1024 // samakan dengan plafon WA di lib/simple.js (maxMedia)
const MIME_BY_EXT = {
  '.js': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown',
  '.html': 'text/html', '.css': 'text/css', '.xml': 'application/xml', '.csv': 'text/csv',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.opus': 'audio/opus',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.apk': 'application/vnd.android.package-archive',
}
const mimeOf = name => MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream'
const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B'
const pipe2 = text => (text ?? '').split('|').map(v => v.trim())

export async function ownerFileCommands(m, { conn, args, text, command, usedPrefix = '.' }) {
  if (conn.role === 'sub') throw 'Perintah ini hanya untuk bot utama.'
  const ops = global.fileOps ?? defaultOps
  const p = usedPrefix
  text = (text ?? '').trim()

  if (command === 'cd') {
    if (!text) { const now = await ops.fileOp('pwd'); return m.reply(`📁 Direktori sekarang:\n${now.path}`) }
    const r = await ops.fileOp('chdir', text)
    return m.reply(`✅ Berhasil pindah ke:\n${r.path}`)
  }

  if (/^(ls|dir)$/i.test(command)) {
    const r = await ops.fileOp('list', text || undefined)
    if (!r.entries.length) return m.reply(`📭 Direktori kosong:\n${r.path}`)
    const shown = r.entries.slice(0, 100)
    const lines = shown.map((e, i) => e.type === 'dir' ? `${i + 1}. 📁 ${e.name}/` : `${i + 1}. 📄 ${e.name} (${fmtSize(e.size)})`)
    if (r.entries.length > shown.length) lines.push(`…dan ${r.entries.length - shown.length} lainnya`)
    return m.reply(`📁 *${r.rel}* — ${r.entries.length} item\n\n${lines.join('\n')}`)
  }

  if (/^r(ead)?f(ile)?$/i.test(command)) {
    if (!text) throw `📂 Masukkan path file yang ingin dibaca.\nContoh: ${p}readfile plugins/owner/cd.js`
    const st = await ops.fileOp('stat', text)
    if (!st.exists) throw `File tidak ditemukan: ${text}`
    if (st.type !== 'file') throw 'Target bukan file. Pakai ls untuk melihat isi direktori.'
    const { data } = await ops.fileOp('read', text, { as: 'text' })
    if (!data.length) return m.reply('📄 File kosong.')
    if (data.includes('\0')) return m.reply('📄 File ini tampaknya biner, bukan teks. Pakai getfile untuk mengambilnya sebagai dokumen.')
    if (data.length > TEXT_AS_DOCUMENT_OVER) {
      await m.reply('📄 File terlalu panjang, dikirim sebagai dokumen...')
      return conn.sendMessage(m.chat, { document: Buffer.from(data), fileName: path.basename(st.path), mimetype: mimeOf(st.path) }, { quoted: m })
    }
    return m.reply(data)
  }

  if (/^e(dit)?f(ile)?$/i.test(command)) {
    const [file, oldTxt, ...rest] = pipe2(text)
    const newTxt = rest.join('|')
    if (!file || !oldTxt || !newTxt) throw `✍️ Format: ${p}editfile <file> | <teks lama> | <teks baru>`
    const r = await ops.fileOp('edit', file, { find: oldTxt, with: newTxt })
    return m.reply(`✅ Edit berhasil!\n\n📄 File: ${r.rel}\n🔁 Diganti: ${r.replacements}x`)
  }

  if (command === 'getfile') {
    if (!text) throw `📂 Masukkan path file yang ingin diambil.\nContoh: ${p}getfile databases/chats.json`
    const st = await ops.fileOp('stat', text)
    if (!st.exists) throw `File tidak ditemukan: ${text}`
    if (st.type !== 'file') throw 'Target bukan file.'
    if (st.size > MAX_GETFILE_BYTES) throw `File terlalu besar untuk dikirim (${fmtSize(st.size)}, batas ${fmtSize(MAX_GETFILE_BYTES)}).`
    const { data } = await ops.fileOp('read', text, { as: 'buffer', maxBytes: MAX_GETFILE_BYTES })
    return conn.sendMessage(m.chat, { document: data, fileName: path.basename(st.path), mimetype: mimeOf(st.path) }, { quoted: m })
  }

  if (/^(createdir|mkdir)$/i.test(command)) {
    if (!text) throw `📁 Masukkan nama direktori.\nContoh: ${p}mkdir assets/images`
    const r = await ops.fileOp('mkdir', text)
    return m.reply(`✅ Direktori berhasil dibuat:\n${r.path}`)
  }

  if (/^(rm|del)dir$/i.test(command)) {
    if (!text) throw `🗑️ Masukkan nama direktori.\nContoh: ${p}rmdir folderLama`
    const st = await ops.fileOp('stat', text)
    if (!st.exists) throw 'Direktori tidak ditemukan.'
    if (st.type !== 'dir') throw 'Target bukan direktori.'
    const r = await ops.fileOp('remove', text)
    return m.reply(`✅ Direktori berhasil dihapus:\n${r.path}`)
  }

  if (/^(cleandir|cleanfolder)$/i.test(command)) {
    const r = await ops.fileOp('clear', text || undefined)
    if (!r.removed) return m.reply('🧹 Direktori sudah kosong.')
    return m.reply(`✅ Isi direktori berhasil dibersihkan (${r.removed} item):\n${r.path}`)
  }

  if (command === 'copyfile') {
    const [src, dest] = pipe2(text)
    if (!src || !dest) throw `📁 Format: ${p}copyfile <sumber|nomor> | <tujuan>`
    const r = await ops.fileOp('copy', src, { to: dest })
    return m.reply(`✅ Berhasil dicopy\n\n📄 Dari: ${r.fromRel}\n📂 Ke: ${r.rel}`)
  }

  if (/^copy(dir(ektori)?|folder)$/i.test(command)) {
    const [src, dest] = args ?? []
    if (!src || !dest) throw `📁 Format: ${p}copydir <folder|nomor> <tujuan>`
    const st = await ops.fileOp('stat', src)
    if (!st.exists || st.type !== 'dir') throw 'Sumber bukan direktori.'
    const r = await ops.fileOp('copy', src, { to: dest })
    return m.reply(`✅ Berhasil copy folder!\n\n📁 ${r.fromRel} → ${r.rel}`)
  }

  if (/^(move(file)?|mv)$/i.test(command)) {
    const [target, destDir] = pipe2(text)
    if (!target || !destDir) throw `📂 Format: ${p}movefile <file|nomor> | <folder tujuan>`
    const srcSt = await ops.fileOp('stat', target)
    if (!srcSt.exists) throw 'Target tidak ditemukan.'
    const dirSt = await ops.fileOp('stat', destDir)
    if (!dirSt.exists || dirSt.type !== 'dir') throw 'Folder tujuan tidak ditemukan.'
    const r = await ops.fileOp('move', target, { to: path.join(dirSt.path, path.basename(srcSt.path)) })
    return m.reply(`✅ Berhasil dipindahkan:\n\n📄 ${r.fromRel}\n📁 ${r.rel}`)
  }

  if (/^r(e)?n(ame)?(fo(lder)?|dir(ektori)?)$/i.test(command)) {
    const [target, newName] = pipe2(text)
    if (!target || !newName) throw `📂 Format: ${p}renamefolder <folder|nomor> | <nama baru>`
    const srcSt = await ops.fileOp('stat', target)
    if (!srcSt.exists || srcSt.type !== 'dir') throw 'Target bukan direktori.'
    const r = await ops.fileOp('move', target, { to: path.join(path.dirname(srcSt.path), newName) })
    return m.reply(`✅ Berhasil rename folder\n\n📁 Lama: ${srcSt.rel}\n✏️ Baru: ${r.rel}`)
  }

  if (/^c(ari)?f(ile)?$/i.test(command)) {
    const keyword = args?.[0]
    const ext = args?.[1]
    if (!keyword) throw `🔍 Format: ${p}carifile <kata kunci> [filter ekstensi]\nContoh: ${p}carifile sailox .js`
    const r = await ops.fileOp('search', undefined, { query: keyword, ext })
    if (!r.matches.length) return m.reply(`❌ Tidak ada file di "${r.rel}" yang mengandung kata *"${keyword}"*${ext ? ` (filter: ${ext})` : ''}.`)
    const shown = r.matches.slice(0, 50)
    const lines = shown.map(f => `• ${f.rel} (${f.count}x)`)
    if (r.matches.length > shown.length) lines.push(`…dan ${r.matches.length - shown.length} lainnya`)
    return m.reply(`*🔍 Ditemukan ${r.matches.length} file mengandung "${keyword}":*\n\n${lines.join('\n')}`)
  }

  throw `Perintah file tidak dikenal: ${command}`
}
