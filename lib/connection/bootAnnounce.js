// Pengumuman boot bot: sekali per proses, kirim "Bot hidup" ke DM founder.
// Deterministik — jalan di tiap boot (VM restart, restart manual, pindah host),
// tanpa melibatkan agen. Gagal kirim = best-effort, tidak pernah menggagalkan boot.
// Sekali-per-proses dijamin pemanggil (runtime.js: setelah flag `restored`).
import { printError } from '../print.js'

const WITA = 'Asia/Makassar'

export function bootAnnounceText(now = new Date()) {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: WITA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)
  return `Bot hidup — ${time} WITA`
}

export function founderPn(target = globalThis) {
  return target.founder?.[0]?.[0] || ''
}

export async function sendBootAnnouncement(sock, { enabled, founder, now } = {}) {
  const on = enabled ?? globalThis.bootAnnounce !== false
  if (!on) return false
  const pn = founder ?? founderPn()
  if (!pn) return false
  try {
    await sock.sendMessage(pn + '@s.whatsapp.net', { text: bootAnnounceText(now) })
    return true
  } catch (e) {
    printError(e, { module: 'boot-announce' })
    return false
  }
}
