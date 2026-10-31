// plugins/anime/pilih.js
//
// Melanjutkan alur anime (.ongoing / .carianime / .anime) satu langkah
// berdasarkan nomor pilihan. Di tahap terakhir (provider), unduhan
// dieksekusi lewat runDownloadJob supaya perilakunya sama dengan
// downloader lain: info file dikirim dulu, file ≤150 MB dikirim ke WA,
// yang lebih besar disimpan ke disk dan jalurnya dilaporkan.
//
// Khusus alur ini job memasang linkOnlyIfOversize: bila ukuran SUDAH
// diketahui dari getInfo dan melewati plafon WA, file TIDAK diunduh sama
// sekali — yang dikirim hanya link-nya. Sesudah link terkirim, khusus
// owner/founder dibuka sesi penawaran (TTL 10 menit): teks persis "y"
// (tanpa reply, ditangkap handler.before di file ini) mengeksekusi
// simpan lokal — unduh ke disk tanpa kirim WA — lalu upload ke Google
// Drive memakai subsistem yang sama dengan .uptodrive (lib/gdrive,
// folder tujuan bawaan yang sama; nama sama di Drive dilewati).
// Kasus provider tanpa engine (🔗) tetap link polos tanpa penawaran:
// bot memang tidak punya cara mengunduhnya.

import path from 'node:path'
import fsp from 'node:fs/promises'
import { runDownloadJob, formatSize } from '#lib/downloader/runJob.js'
import { getFlow, setFlow, clearFlow, flowKey, advanceFlow, ensureEngines } from '#lib/helpers/animeFlow.js'
import { getDriveClient } from '#lib/gdrive/client.js'
import { syncFileToDrive, defaultTargetFolderId } from '#lib/gdrive/sync.js'

export const OVERSIZE_OFFER_TEXT = 'Balas y jika ingin menyimpannya secara lokal _dan upload ke cloud_?'
export const OVERSIZE_OFFER_TTL_MS = 10 * 60 * 1000

export function createOversizeOfferStore({ ttlMs = OVERSIZE_OFFER_TTL_MS, now = Date.now } = {}) {
  const map = new Map()
  const keyOf = (chat, sender) => `${chat}|${sender}`
  return {
    put(chat, sender, data) {
      const t = now()
      for (const [k, v] of map) if (v.expiresAt <= t) map.delete(k)
      map.set(keyOf(chat, sender), { ...data, expiresAt: t + ttlMs })
    },
    get(chat, sender) {
      const o = map.get(keyOf(chat, sender))
      if (!o) return null
      if (o.expiresAt <= now()) { map.delete(keyOf(chat, sender)); return null }
      return o
    },
    delete(chat, sender) { map.delete(keyOf(chat, sender)) },
  }
}

const oversizeOffers = createOversizeOfferStore()

function projectRoot() {
  const pluginsRoot = global.pluginLoader?.root
  return pluginsRoot ? path.resolve(pluginsRoot, '..') : process.cwd()
}

let handler = async (m, ctx) => {
  const { conn, text, usedPrefix, command } = ctx
  const key = flowKey(m)
  const flow = getFlow(key)
  if (!flow) {
    throw '❌ Belum ada daftar anime aktif (atau sudah kedaluwarsa 10 menit).\nMulai dari *.ongoing*, *.carianime <judul>*, atau *.anime <link>* dulu.'
  }
  const n = parseInt(String(text || '').trim(), 10)
  if (!Number.isInteger(n) || n < 1) throw `❌ Contoh: ${usedPrefix + command} 3`

  await ensureEngines()

  let step
  try {
    step = await advanceFlow(flow, n)
  } catch (e) {
    throw `❌ ${e.message || e}`
  }

  if (step.type === 'view') {
    if (step.flow) setFlow(key, step.flow)
    return m.reply(step.text)
  }
  if (step.type === 'link') {
    return m.reply(step.text)
  }
  // step.type === 'download'
  clearFlow(key)
  const job = {
    id: Date.now().toString(36),
    provider: step.provider,
    url: step.url,
    chat: m.chat,
    sender: m.sender,
    senderName: m.pushName || '',
    linkOnlyIfOversize: true,
  }
  const run = ctx?.runDownloadJob ?? runDownloadJob
  let result
  try {
    result = await run({ conn, job, rootDir: projectRoot() })
  } catch (e) {
    if (e?.code === 'NO_CONN') throw '❌ Koneksi WhatsApp belum siap untuk mengunduh.'
    return m.reply(`❌ Unduhan gagal:\n${e.message || e}`)
  }
  // Link terkirim karena oversize: tawarkan simpan lokal — hanya ke
  // owner/founder (cek peran dari konteks pipeline).
  if (result?.kind === 'link' && result.reason === 'oversize' && (ctx?.isFounder || ctx?.isOwner)) {
    const store = ctx?.oversizeOffers ?? oversizeOffers
    store.put(m.chat, m.sender, { provider: result.provider, url: result.url, fileName: result.fileName, size: result.size })
    await m.reply(OVERSIZE_OFFER_TEXT)
  }
}

handler.help = ['pilih <nomor>']
handler.tags = ['anime']
handler.command = /^pilih$/i
handler.founder = true

async function defaultUploadToDrive(localPath) {
  const client = globalThis.uptodriveClient ?? getDriveClient({ rootDir: projectRoot() })
  return syncFileToDrive(client, localPath, defaultTargetFolderId())
}

// Bagian cloud dari penawaran: upload file yang baru disimpan lokal ke
// Google Drive. Kegagalan upload TIDAK menggagalkan simpan lokal — file
// tetap di disk dan kegagalannya dilaporkan apa adanya (error mentah ke
// terminal + balasan chat, sesuai standar logging downloader).
async function uploadSavedFile(m, ctx, result) {
  const localPath = result?.filePath
  const stat = localPath ? await fsp.stat(localPath).catch(() => null) : null
  if (!stat?.isFile()) {
    await m.reply('☁️ Upload ke Drive dilewati: file hasil simpan tidak ditemukan di disk.')
    return
  }
  await m.reply(`☁️ Mengunggah ke Google Drive...\n📄 ${path.basename(localPath)} — ${formatSize(stat.size)}`)
  try {
    const upload = ctx?.uploadToDrive ?? defaultUploadToDrive
    const res = await upload(localPath)
    if (res.status === 'skipped') {
      await m.reply(`⏭️ Upload Drive dilewati: ${res.reason}\n📄 ${res.fileName}`)
    } else {
      await m.reply(`✅ *Upload ke Drive selesai!*\n📄 ${res.fileName} — ${formatSize(res.size)}` + (res.webViewLink ? `\n🔗 ${res.webViewLink}` : ''))
    }
  } catch (e) {
    console.error('[pilih] upload Drive gagal:', e)
    await m.reply(`⚠️ File tersimpan lokal, tapi upload ke Drive gagal:\n${e.message || e}`)
  }
}

// Penawaran simpan lokal kasus oversize: teks persis "y" (teks biasa,
// tanpa reply) dari pembuka sesi di chat yang sama mengeksekusi unduhan
// ke disk, lalu upload ke Drive. Sesi hanya pernah dibuka untuk
// owner/founder, dan peran dicek ulang di sini sebelum eksekusi. Pesan
// lain / tanpa sesi / dari bot sendiri dilewati begitu saja (return false).
handler.before = async (m, ctx) => {
  if (m.fromMe) return false
  if ((m.text ?? '').trim().toLowerCase() !== 'y') return false
  const store = ctx?.oversizeOffers ?? oversizeOffers
  const offer = store.get(m.chat, m.sender)
  if (!offer) return false
  if (!ctx?.isFounder && !ctx?.isOwner) return false
  store.delete(m.chat, m.sender)
  const conn = ctx?.conn ?? m.conn
  const run = ctx?.runDownloadJob ?? runDownloadJob
  const job = {
    id: Date.now().toString(36),
    provider: offer.provider,
    url: offer.url,
    chat: m.chat,
    sender: m.sender,
    senderName: m.pushName || '',
  }
  let result
  try {
    result = await run({ conn, job, rootDir: projectRoot() })
  } catch (e) {
    if (e?.code === 'NO_CONN') { await m.reply('❌ Koneksi WhatsApp belum siap untuk mengunduh.'); return true }
    await m.reply(`❌ Gagal menyimpan file:\n${e.message || e}`)
    return true
  }
  await uploadSavedFile(m, ctx, result)
  return true
}

export default handler
