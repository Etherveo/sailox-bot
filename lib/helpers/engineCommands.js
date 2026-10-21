// lib/helpers/engineCommands.js
//
// CRUD engine downloader KHUSUS bot utama (owner) — pasangan dari
// ownerPluginCommands.js, tapi untuk engine di lib/downloader/engines/.
// Tujuannya persis permintaan pemilik: menambah/mengganti engine tidak
// perlu lagi upload file lewat panel/SSH — cukup dari chat WhatsApp:
//
//   .saveengine <nama>   (balas teks kode / file .js) -> tulis + hot-reload
//   .getengine <nama>    -> lihat kode engine
//   .deleteengine <nama> -> hapus file + unload dari registry
//   .listengine          -> daftar engine yang aktif
//
// Aturan mainnya meniru saveplugin owner:
//  - Kode yang syntax error / tidak memenuhi kontrak engine DITOLAK
//    sebelum apa pun ditulis (inspectEngine: ekspor id/match/getInfo/
//    download wajib ada).
//  - Penulisan atomik (file sementara + rename).
//  - Setelah tertulis, engine langsung dimuat ulang lewat registry
//    (import ?v=N). Bila muat ulang gagal, file tetap tersimpan tapi
//    versi lama tetap aktif dan kegagalannya dilaporkan apa adanya.
//  - `id` yang diekspor kode harus sama dengan nama file, supaya
//    .listengine dan deteksi provider tidak ambigu.

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { downloaderRegistry, ensureEngines, inspectEngine, engineName } from '../downloader/index.js'

const MAX_KB = 512

async function extractCode(m, text, rawTarget) {
  // Pola yang sama seperti ownerPluginCommands.extractCode.
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
  throw 'Balas pesan teks berisi kode engine, atau balas/kirim file .js.'
}

function registryOf(ctx) {
  // Untuk tes: registry bisa diinjeksi lewat ctx.downloaderRegistry.
  return ctx?.downloaderRegistry ?? downloaderRegistry
}

export async function ownerEngineCRUD(m, { conn, args, text, command, ...ctx }) {
  if (conn.role === 'sub') throw 'Perintah ini hanya untuk bot utama.'
  const registry = registryOf(ctx)
  if (registry === downloaderRegistry) await ensureEngines()
  const dir = registry.dir

  try {
    if (/^(saveengine|se)$/i.test(command)) {
      const rawTarget = args[0]
      if (!rawTarget) throw 'Gunakan .saveengine <nama> sambil membalas kode teks atau file .js.'
      const name = engineName(rawTarget)
      const code = await extractCode(m, text ?? '', rawTarget)

      let inspected
      try { inspected = inspectEngine(code, MAX_KB) } catch (e) { throw `Engine ditolak: ${e.message}` }

      await fs.mkdir(dir, { recursive: true })
      const target = path.join(dir, `${name}.js`)
      const tmp = path.join(dir, '.' + randomUUID() + '.tmp')
      await fs.writeFile(tmp, inspected.code, { mode: 0o600, flag: 'wx' })
      try { await fs.rename(tmp, target) } finally { await fs.rm(tmp, { force: true }) }

      const result = await registry.reload(name)
      if (!result.ok) {
        await m.reply(`File tersimpan: lib/downloader/engines/${name}.js\nTapi hot-reload gagal: ${result.error ?? 'tidak diketahui'}\nVersi lama (bila ada) tetap aktif; perbaiki kodenya lalu simpan lagi.`)
      } else {
        await m.reply(`Tersimpan & langsung aktif (hot-reload): engine *${result.id}*\nProvider sekarang: ${registry.supportedProviders().join(', ')}`)
      }
    } else if (/^(getengine|ge)$/i.test(command)) {
      const rawTarget = args[0]
      if (!rawTarget) throw 'Gunakan .getengine <nama>.'
      const name = engineName(rawTarget)
      const file = path.join(dir, `${name}.js`)
      const stat = await fs.stat(file).catch(() => null)
      if (!stat) throw 'Engine tidak ditemukan.'
      if (stat.size > MAX_KB * 1024) throw 'Engine terlalu besar.'
      const data = await fs.readFile(file)
      await (data.length <= 3000
        ? m.reply(data.toString())
        : conn.sendFile(m.chat, data, `${name}.js`, '', m, false, { mimetype: 'text/javascript' }))
    } else if (/^(deleteengine|delengine|de)$/i.test(command)) {
      const rawTarget = args[0]
      if (!rawTarget) throw 'Gunakan .deleteengine <nama>.'
      const name = engineName(rawTarget)
      const file = path.join(dir, `${name}.js`)
      if (!(await fs.stat(file).catch(() => null))) throw 'Engine tidak ditemukan.'
      await fs.unlink(file)
      registry.unregister(name)
      await m.reply(`Dihapus & di-unload (hot-reload): engine *${name}*\nProvider tersisa: ${registry.supportedProviders().join(', ') || '(tidak ada)'}`)
    } else if (/^(listengine|le)$/i.test(command)) {
      const active = registry.list()
      let onDisk = []
      try { onDisk = (await fs.readdir(dir)).filter(f => f.endsWith('.js') && !f.startsWith('.')) } catch { /* folder belum ada */ }
      const activeFiles = new Set(active.map(e => e.file))
      const inactive = onDisk.filter(f => !activeFiles.has(f))
      if (!active.length && !inactive.length) throw 'Belum ada engine.'
      const lines = active.map(e => `  • ${e.id} (${e.file})`).join('\n')
      await m.reply(
        `⚙️ *Engine downloader aktif* (${active.length})\n${lines}` +
        (inactive.length ? `\n\n⚠️ Ada di disk tapi tidak aktif (gagal dimuat):\n${inactive.map(f => `  • ${f}`).join('\n')}` : '') +
        `\n\nKelola: .saveengine / .getengine / .deleteengine\nAturan engine vs plugin: docs/engine-plugin-downloader.md`
      )
    }
  } catch (e) { if (typeof e === 'string') throw e; throw `Operasi engine gagal: ${e.message}` }
}
