// lib/helpers/premium.js
//
// Satu definisi premium untuk seluruh bot (dipakai pipeline, .profile,
// dan plugin apa pun yang butuh status premium).
//
// Arti field di record users (terverifikasi dari pipeline lama):
//   premium     — boolean, apakah user ini premium
//   premiumTime — batas akhir premium, ms sejak epoch; 0 / tidak diset =
//                 permanen (tidak pernah kedaluwarsa). Bila terisi dan
//                 sudah lewat, premium dianggap habis.
import { duration } from './time.js'

// Cabut premium yang sudah kedaluwarsa (mutasi record). Dipanggil
// pipeline sekali per pesan masuk, sebelum gerbang apa pun membaca
// status premium — jadi tidak ada user kedaluwarsa yang lolos.
export function refreshPremium(user, now = Date.now()) {
  if (user?.premiumTime && user.premiumTime <= now) {
    user.premium = false
    user.premiumTime = 0
    return true
  }
  return false
}

// Premium aktif? premiumTime 0 = permanen; terisi tapi sudah lewat =
// tidak premium lagi (kedaluwarsa ditegakkan di sini, bukan cuma di
// refreshPremium — supaya pemanggil yang tidak sempat refresh tetap
// mendapat jawaban yang benar).
export function isPremium(user, now = Date.now()) {
  if (!user?.premium) return false
  if (!user.premiumTime) return true
  return user.premiumTime > now
}

// Sisa premium dalam ms; 0 bila tidak premium/habis, Infinity bila
// permanen.
export function premiumRemainingMs(user, now = Date.now()) {
  if (!isPremium(user, now)) return 0
  if (!user.premiumTime) return Infinity
  return Math.max(0, user.premiumTime - now)
}

// Sisa waktu premium dalam Bahasa Indonesia, lengkap sampai detik:
// "3 hari 4 jam 12 menit 30 detik", "12 menit 30 detik", "30 detik".
// 'permanen' bila tanpa batas akhir; 'tidak premium' bila memang
// bukan premium; 'habis' bila flag premium masih ada tapi waktunya
// sudah lewat.
export function formatPremiumRemaining(user, now = Date.now()) {
  if (!user?.premium) return 'tidak premium'
  if (!user.premiumTime) return 'permanen'
  const ms = premiumRemainingMs(user, now)
  if (ms <= 0) return 'habis'
  return duration(ms)
}
