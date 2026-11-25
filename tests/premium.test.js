// tests/premium.test.js — helper premium (lib/helpers/premium.js).
// premiumTime adalah timestamp kedaluwarsa (ms epoch); 0/tidak ada =
// permanen (semantik ini dibuktikan dari pipeline.js sebelum helper
// ditulis — lihat laporan).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPremium, refreshPremium, premiumRemainingMs, formatPremiumRemaining } from '../lib/helpers/premium.js'

const NOW = 1764072000000

test('isPremium: aktif bila premium dan premiumTime belum lewat', () => {
  assert.equal(isPremium({ premium: true, premiumTime: NOW + 60_000 }, NOW), true)
  assert.equal(isPremium({ premium: true, premiumTime: NOW + 1 }, NOW), true)
  assert.equal(isPremium({ premium: true, premiumTime: NOW }, NOW), false, 'tepat di batas habis = tidak premium')
})

test('isPremium: premiumTime 0/tidak ada = permanen', () => {
  assert.equal(isPremium({ premium: true, premiumTime: 0 }, NOW), true)
  assert.equal(isPremium({ premium: true }, NOW), true)
})

test('isPremium: kedaluwarsa atau premium=false = tidak premium', () => {
  assert.equal(isPremium({ premium: true, premiumTime: NOW - 1 }, NOW), false)
  assert.equal(isPremium({ premium: false, premiumTime: NOW + 60_000 }, NOW), false)
  assert.equal(isPremium({ premium: false, premiumTime: 0 }, NOW), false)
})

test('refreshPremium: mencabut flag + premiumTime yang kedaluwarsa (mutasi)', () => {
  const u = { premium: true, premiumTime: NOW - 5000 }
  assert.equal(refreshPremium(u, NOW), true)
  assert.equal(u.premium, false)
  assert.equal(u.premiumTime, 0)
  const v = { premium: true, premiumTime: NOW + 5000 }
  assert.equal(refreshPremium(v, NOW), false)
  assert.equal(v.premium, true)
  assert.equal(v.premiumTime, NOW + 5000)
  const w = { premium: true, premiumTime: 0 }
  assert.equal(refreshPremium(w, NOW), false, 'permanen tidak dicabut')
})

test('premiumRemainingMs: hitung mundur, 0 bila habis, Infinity bila permanen', () => {
  assert.equal(premiumRemainingMs({ premium: true, premiumTime: NOW + 90_000 }, NOW), 90_000)
  assert.equal(premiumRemainingMs({ premium: true, premiumTime: NOW - 1 }, NOW), 0)
  assert.equal(premiumRemainingMs({ premium: true, premiumTime: 0 }, NOW), Infinity)
  assert.equal(premiumRemainingMs({ premium: false, premiumTime: NOW + 90_000 }, NOW), 0)
})

test('formatPremiumRemaining: teks lengkap hari/jam/menit/detik', () => {
  assert.equal(formatPremiumRemaining({ premium: true, premiumTime: NOW + 3 * 86400_000 + 4 * 3600_000 + 12 * 60_000 + 30_000 }, NOW), '3 hari 4 jam 12 menit 30 detik')
  assert.equal(formatPremiumRemaining({ premium: true, premiumTime: NOW + 12 * 60_000 + 30_000 }, NOW), '12 menit 30 detik')
  assert.equal(formatPremiumRemaining({ premium: true, premiumTime: NOW + 30_000 }, NOW), '30 detik')
  assert.equal(formatPremiumRemaining({ premium: true, premiumTime: NOW + 1000 }, NOW), '1 detik')
  assert.equal(formatPremiumRemaining({ premium: true, premiumTime: 0 }, NOW), 'permanen')
  assert.equal(formatPremiumRemaining({ premium: false, premiumTime: NOW + 60_000 }, NOW), 'tidak premium')
  assert.equal(formatPremiumRemaining({ premium: true, premiumTime: NOW - 1000 }, NOW), 'habis')
})
