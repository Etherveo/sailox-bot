// .animedownload / .adl / .animedl / .nimedl — ".dl versi Anime Only"
// khusus founder (Fase 3 peta konsep .animedownload).
//
// Format: <url> | <customName opsional> | <isUpload 1/0, bawaan 1>
// - Provider dibatasi tujuh: pixeldrain, mediafire, gofile, gdrive,
//   mega, mp4upload, kdrive. Di luar itu ditolak di muka.
// - Job masuk ANTREAN YANG SAMA dengan .dl (keputusan Veo), dengan
//   options khusus yang dibaca runJob: nama di-resolusi dari mapping
//   nama anime (customName menimpa mapping), SEMUA file dikirim
//   sebagai dokumen, permukaan Penjaga Kirim Besar sendiri, dan
//   isUpload=1 menahan penghapusan folder job sesudah kirim WA
//   (upload Drive-nya sendiri dikerjakan Fase 4).
import path from 'node:path'
import {
  ensureEngines,
  downloaderRegistry,
  getDownloadQueue,
  ensureJobProcessor,
  providerLabel,
  attachEngineNotifierWithConn,
} from '#lib/downloader/index.js'

const ANIME_PROVIDERS = new Set(['pixeldrain', 'mediafire', 'gofile', 'gdrive', 'mega', 'mp4upload', 'kdrive'])
const BIG_SEND_SURFACE = 'downloader/animedownload.js'

function projectRoot() {
  const pluginsRoot = global.pluginLoader?.root
  return pluginsRoot ? path.resolve(pluginsRoot, '..') : process.cwd()
}

const providersText = () => [...ANIME_PROVIDERS].map(id => `• ${providerLabel(id)}`).join('\n')

function parseIsUpload(raw) {
  if (raw === undefined || raw === '') return true
  if (/^(1|ya|yes|true|y)$/i.test(raw)) return true
  if (/^(0|tidak|no|false|n)$/i.test(raw)) return false
  return null
}

let handler = async (m, ctx) => {
  const { conn, text, usedPrefix, command } = ctx
  await ensureEngines()
  attachEngineNotifierWithConn(conn)

  const registry = ctx.downloaderRegistry ?? downloaderRegistry
  const rootDir = projectRoot()
  const queue = ctx.downloadQueue ?? getDownloadQueue(rootDir)
  ensureJobProcessor({ conn, queue, registry, rootDir })

  const raw = (text ?? '').trim()
  if (!raw) {
    throw (
      `📥 *AnimeDownload — unduh khusus anime, semua file jadi dokumen*\n\n` +
      `Format: ${usedPrefix}${command} <url> | <nama custom opsional> | <isUpload 1/0>\n` +
      `Contoh: ${usedPrefix}${command} https://pixeldrain.com/d/xxxx\n\n` +
      `Nama custom mengabaikan mapping; kosongkan untuk nama otomatis (mapping → nama asli).\n` +
      `isUpload bawaan 1: file diunggah ke Drive sesudah terkirim ke WA.\n\n` +
      `Provider yang didukung:\n${providersText()}`
    )
  }

  const parts = raw.split('|').map(s => s.trim())
  const urlPart = parts[0]
  let parsedUrl
  try { parsedUrl = new URL(urlPart) } catch { throw '❌ URL tidak valid.' }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw '❌ URL harus http(s).'
  const url = parsedUrl.href

  const customName = parts[1] || null
  if (customName && customName.length > 150) {
    return m.reply('❌ Nama file custom maksimal 150 karakter.')
  }

  const isUpload = parseIsUpload(parts[2])
  if (isUpload === null) {
    throw `❌ Nilai isUpload tidak dikenal: "${parts[2]}". Pakai 1 (upload ke Drive) atau 0 (tidak).`
  }

  const providerId = registry.detectProvider(url)
  if (!providerId) {
    throw `❌ Domain link ini belum didukung sama sekali.\nProvider yang didukung perintah ini:\n${providersText()}`
  }
  if (!ANIME_PROVIDERS.has(providerId)) {
    throw `❌ Provider ${providerLabel(providerId)} tidak termasuk AnimeDownload (khusus anime).\nProvider yang didukung perintah ini:\n${providersText()}`
  }

  const { job, position } = await queue.enqueue({
    url,
    provider: providerId,
    chat: m.chat,
    sender: m.sender,
    senderName: m.pushName || m.name || '',
    userMsgKey: m.key ?? null,
    options: {
      animeName: true,
      customName,
      forceDocument: true,
      uploadToDrive: isUpload,
      bigSendSurface: BIG_SEND_SURFACE,
    },
  })

  return m.reply(
    `📥 *Masuk antrean #${job.id}* — AnimeDownload\n` +
    `🌐 Provider: ${providerLabel(providerId)}\n` +
    `📄 Nama: ${customName ? `custom — ${customName}` : 'otomatis (mapping → nama asli)'}\n` +
    `☁️ Upload Drive: ${isUpload ? 'Ya (sesudah terkirim ke WA)' : 'Tidak'}\n` +
    `📍 Posisi menunggu: ${position}\n\n` +
    `Info file akan dikirim begitu giliranmu diproses; semua file dikirim sebagai dokumen.`
  )
}

handler.help = ['animedownload <url> | nama custom | isUpload(1/0)']
handler.tags = ['downloader']
handler.command = /^(animedownload|adl|animedl|nimedl)$/i
handler.founder = true
handler.bigSend = true

export default handler
