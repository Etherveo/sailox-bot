import fs from 'node:fs/promises'
import { savePluginFile, deletePluginFile, findPluginFile, inspectPlugin, parsePluginTarget } from '../plugins/files.js'

// CRUD plugin KHUSUS bot utama (owner). Sengaja dipisah dari pluginCommands.js:
// helper itu dipakai template jadibot/sub-bot dengan kebijakan sandbox & persetujuan
// operatornya sendiri, sedangkan versi owner ini langsung menulis ke plugins/ bot
// utama dan selalu memicu hot-reload eksplisit lewat loader (savePluginFile memanggil
// loader.reload, deletePluginFile memanggil loader.remove — blueprint 9.9/9.10),
// jadi watcher hanya cadangan dan tidak perlu restart proses.
const MAX_KB = 512

async function extractCode(m, text, rawTarget) {
  // Prioritas: lampiran dokumen pada pesan yang dibalas / pesan perintah itu sendiri.
  for (const src of [m.quoted, m]) {
    if (!src?.mediaMessage) continue
    if (src.mediaType !== 'document') throw 'Lampiran harus berupa file dokumen .js.'
    const fileName = src.msg?.fileName ?? ''
    if (!/\.js$/i.test(fileName)) throw `Lampiran harus berekstensi .js (ini: ${fileName || 'tanpa nama'}).`
    return await src.download()
  }
  if (m.quoted?.text) return m.quoted.text
  const inline = text.slice(rawTarget.length).trimStart()
  if (inline) return inline
  throw 'Balas pesan teks berisi kode plugin, atau balas/kirim file .js.'
}

export async function ownerPluginCRUD(m, { conn, args, text, command }) {
  if (conn.role === 'sub') throw 'Perintah ini hanya untuk bot utama.'
  const loader = global.pluginLoader
  if (!loader) throw 'Plugin loader belum siap.'
  const root = loader.root
  try {
    if (/^s(?:ave)?p(?:lugin)?$/i.test(command)) {
      const rawTarget = args[0]
      if (!rawTarget) throw 'Gunakan .sp <nama|kategori-nama> sambil membalas kode teks atau file .js.'
      const code = await extractCode(m, text ?? '', rawTarget)
      // Seperti saveplugin legacy: kode yang syntax error DITOLAK sebelum apa pun ditulis.
      let inspected
      try { inspected = inspectPlugin(code, MAX_KB) } catch (e) { throw e instanceof SyntaxError ? `Plugin ditolak, syntax error: ${e.message}` : `Plugin ditolak: ${e.message}` }
      const target = await parsePluginTarget(root, rawTarget, { tag: inspected.tag })
      const result = await savePluginFile({ root, name: target.name, category: target.category ?? undefined, code: inspected.code, loader, maxKB: MAX_KB })
      if (!result.ok) await m.reply(`File tersimpan: ${result.id}\nTapi hot-reload gagal: ${result.error ?? 'tidak diketahui'}\nVersi lama (bila ada) tetap aktif; perbaiki kodenya lalu simpan lagi.`)
      else if (result.unchanged) await m.reply(`Tidak ada perubahan: ${result.id} sudah versi terbaru.`)
      else await m.reply(`Tersimpan & langsung aktif (hot-reload): ${result.id}\nCommand: ${result.command ?? '-'}`)
    } else if (/^g(?:et)?p(?:lugin)?$/i.test(command)) {
      // Default: kirim sebagai TEKS. File hanya bila diminta eksplisit
      // (.gp -f <nama>) atau bila teksnya melewati 65000 karakter
      // (di atas itu pesan teks WhatsApp tidak muat).
      const wantsFile = args[0] === '-f'
      const rawTarget = wantsFile ? args[1] : args[0]
      if (!rawTarget) throw 'Gunakan .gp [-f] <nama|kategori-nama>.'
      const target = await parsePluginTarget(root, rawTarget)
      const found = await findPluginFile(root, target.query)
      if (!found) throw 'Plugin tidak ditemukan.'
      const stat = await fs.stat(found.file)
      if (stat.size > MAX_KB * 1024) throw 'Plugin terlalu besar.'
      const data = await fs.readFile(found.file)
      const text = data.toString()
      await (wantsFile || text.length > 65000
        ? conn.sendFile(m.chat, data, found.id.split('/').at(-1), '', m, false, { mimetype: 'text/javascript' })
        : m.reply(text))
    } else if (/^d(?:el(?:ete)?)?p(?:lugin)?$/i.test(command)) {
      const rawTarget = args[0]
      if (!rawTarget) throw 'Gunakan .dp <nama|kategori-nama>.'
      const target = await parsePluginTarget(root, rawTarget)
      await m.reply(`Dihapus & di-unload (hot-reload): ${await deletePluginFile({ root, name: target.query, loader })}`)
    }
  } catch (e) { if (typeof e === 'string') throw e; throw `Operasi plugin gagal: ${e.message}` }
}
