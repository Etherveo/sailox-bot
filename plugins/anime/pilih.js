// plugins/anime/pilih.js
//
// Melanjutkan alur anime (.ongoing / .carianime / .anime) satu langkah
// berdasarkan nomor pilihan. Di tahap terakhir (provider), unduhan
// dieksekusi lewat runDownloadJob supaya perilakunya sama dengan
// downloader lain: info file dikirim dulu, file ≤20 MB dikirim ke WA,
// yang lebih besar disimpan ke disk dan jalurnya dilaporkan.

import path from 'node:path'
import { runDownloadJob } from '#lib/downloader/runJob.js'
import { getFlow, setFlow, clearFlow, flowKey, advanceFlow, ensureEngines } from '#lib/helpers/animeFlow.js'

function projectRoot() {
  const pluginsRoot = global.pluginLoader?.root
  return pluginsRoot ? path.resolve(pluginsRoot, '..') : process.cwd()
}

let handler = async (m, { conn, text, usedPrefix, command }) => {
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
    senderName: m.pushName || ''
  }
  try {
    await runDownloadJob({ conn, job, rootDir: projectRoot() })
  } catch (e) {
    if (e?.code === 'NO_CONN') throw '❌ Koneksi WhatsApp belum siap untuk mengunduh.'
    return m.reply(`❌ Unduhan gagal:\n${e.message || e}`)
  }
}

handler.help = ['pilih <nomor>']
handler.tags = ['anime']
handler.command = /^pilih$/i
handler.founder = true

export default handler
