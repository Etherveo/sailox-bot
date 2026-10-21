// lib/helpers/kdrivePreResolve.js
//
// Pra-resolusi URL pembungkus kDrive untuk .unduh/.download, dipakai
// SEBELUM engine.getInfo: engine hanya bisa (a) parse halaman v1 — mati
// dari jaringan di luar whitelist — atau (b) memproses URL endpoint
// langsung. Jembatan ke URL endpoint itu ada di sini:
//
//   - Mode direct + pengguna menyertakan URL EPISODE asal link (slot
//     argumen kedua .unduh, pola `| <link episode>`): resolusi LOKAL
//     lewat lib/kuramanime/resolve.js (jalur episode).
//   - Mode stranger + kdrivePeer terpasang: resolusi didelegasikan ke
//     bot pasangan lewat relay (lib/helpers/kdriveRelay.js).
//
// Tanpa konteks episode, mode direct dikembalikan apa adanya (null) —
// engine akan mencoba halaman v1 dan menjelaskan sendiri bila 404.

import { requestResolution as relayResolve, isKdriveWrapperUrl } from './kdriveRelay.js'
import { resolveKdrive as localResolve } from '../kuramanime/resolve.js'

/** Slot argumen kedua dianggap URL episode bila URL http(s) kuramanime. */
export function episodeCandidate(nameArg) {
  if (!nameArg) return undefined
  const text = String(nameArg).trim()
  return /^https?:\/\/\S+$/i.test(text) && /kuramanime\./i.test(text) ? text : undefined
}

/**
 * Kembalikan { url, nameArg, via } bila pra-resolusi dilakukan, atau
 * null bila URL harus diteruskan ke engine apa adanya.
 * deps bisa diinjeksi untuk tes: { relayResolve, localResolve }.
 */
export async function preResolveKdrive({ conn, url, nameArg, config = globalThis, deps = {} } = {}) {
  if (!isKdriveWrapperUrl(url)) return null
  const relay = deps.relayResolve || relayResolve
  const local = deps.localResolve || localResolve
  const episodeUrl = episodeCandidate(nameArg)
  const mode = config.kdriveMode === 'stranger' ? 'stranger' : 'direct'

  if (mode === 'stranger') {
    const peer = String(config.kdrivePeer ?? '').replace(/\D/g, '')
    if (!peer) return null
    const r = await relay(conn, { url, episodeUrl, config })
    return { url: r.fileUrl, nameArg: episodeUrl ? undefined : nameArg, via: 'relay' }
  }

  if (!episodeUrl) return null
  const r = await local(url, { episodeUrl })
  return { url: r.fileUrl, nameArg: undefined, via: 'local-episode' }
}
