// tests/sendGuard.test.js — Penjaga Kirim Besar (lib/helpers/sendGuard.js):
// reservasi, plafon per kelas pelaku, definisi sunyi, tabrakan, masa
// berlaku, mode hati-hati sesudah crash, dan metrik mati. Semua dependensi
// (jam, RSS, memori OS, config) diinjeksi — deterministik, tanpa bot live.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createSendGuard } from '../lib/helpers/sendGuard.js'

const MB = 1024 * 1024
const GB = 1024 * MB
const founderRole = () => ({ isFounder: true, isOwner: true })
const userRole = () => ({ isFounder: false, isOwner: false })
const BASE_CFG = { mode: 'founder', founderCapMB: 1024, userCapMB: 500, founderWaitMin: 3, userWaitMin: 10, commitCapMB: 3500, osReserveMB: 128, pressureMaxPct: 5 }
const SINYAL_LONGAR = { memAvailableBytes: 4 * GB, psiSomeAvg10: 0, cgroupHeadroomBytes: null, balloonBytes: null }

async function buatGuard(t, over = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-guard-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  let nowVal = 1_000_000
  const logs = []
  const guard = createSendGuard({
    now: () => nowVal,
    readRss: () => 0.4 * GB,
    readSignals: () => ({ ...SINYAL_LONGAR }),
    readConfig: () => ({ ...BASE_CFG }),
    surfaceEntitled: () => true,
    subbotWorkers: () => 0,
    markerFile: path.join(dir, 'send-guard.json'),
    log: e => logs.push(e),
    ...over,
  })
  return { guard, logs, dir, advance: ms => { nowVal += ms } }
}
const reqFounder = (sizeMB, actor = 'F1') => ({ surface: 'downloader/unduh.js', actor, roleOf: founderRole, sizeBytes: sizeMB * MB })
const reqUser = (sizeMB, actor = 'U1') => ({ surface: 'downloader/download.js', actor, roleOf: userRole, sizeBytes: sizeMB * MB })

test('penjaga: founder 1 GB diberikan; token sekali pakai; lepas membersihkan', async t => {
  const { guard } = await buatGuard(t)
  const res = await guard.request(reqFounder(1024))
  assert.equal(res.granted, true)
  assert.equal(guard.consume(res.token, 1024 * MB), true)
  assert.equal(guard.consume(res.token, 1024 * MB), false, 'token tidak bisa dipakai dua kali')
  assert.equal(guard.consume('token-ngawur', 10 * MB), false)
  assert.equal(guard.release(res.token), true)
  assert.equal(guard.snapshot().reservations.length, 0)
})

test('penjaga: consume menolak ukuran sebenarnya melebihi yang dipesan', async t => {
  const { guard } = await buatGuard(t)
  const res = await guard.request(reqFounder(200))
  assert.equal(res.granted, true)
  assert.equal(guard.consume(res.token, 201 * MB), false)
  assert.equal(guard.consume(res.token, 200 * MB), true)
})

test('penjaga: mode founder menolak non-founder; mode off menolak semua', async t => {
  const { guard } = await buatGuard(t)
  assert.deepEqual(await guard.request(reqUser(100)), { granted: false, reason: 'mode-founder-only' })
  const { guard: off } = await buatGuard(t, { readConfig: () => ({ ...BASE_CFG, mode: 'off' }) })
  assert.deepEqual(await off.request(reqFounder(100)), { granted: false, reason: 'mode-off' })
})

test('penjaga: plafon per kelas + jepit batas keras di atas config', async t => {
  const { guard } = await buatGuard(t)
  assert.equal((await guard.request(reqFounder(1025))).reason, 'over-cap')
  const { guard: longgar } = await buatGuard(t, { readConfig: () => ({ ...BASE_CFG, founderCapMB: 2000 }) })
  assert.equal((await longgar.request(reqFounder(1100))).reason, 'over-cap', 'config 2000 tetap dijepit batas keras 1024')
})

test('penjaga: permukaan tanpa opt-in bigSend ditolak', async t => {
  const { guard } = await buatGuard(t, { surfaceEntitled: s => s === 'downloader/unduh.js' })
  assert.equal((await guard.request(reqUser(100))).reason, 'surface-not-entitled')
})

test('penjaga: tabrakan dua founder 1 GB — kedua menunggu, lolos sesudah yang pertama lepas', async t => {
  const { guard } = await buatGuard(t)
  const a = await guard.request(reqFounder(1024, 'FA'))
  assert.equal(a.granted, true)
  let bRes = null
  const pB = guard.request(reqFounder(1024, 'FB')).then(v => { bRes = v })
  await new Promise(r => setImmediate(r))
  assert.equal(bRes, null, 'B belum boleh lolos selagi A memegang anggaran')
  guard.release(a.token)
  await pB
  assert.equal(bRes.granted, true)
})

test('penjaga: aktor yang sama tidak boleh punya dua kirim besar sekaligus', async t => {
  const { guard } = await buatGuard(t)
  const a = await guard.request(reqFounder(300, 'FX'))
  assert.equal(a.granted, true)
  assert.equal((await guard.request(reqFounder(300, 'FX'))).reason, 'actor-busy')
})

test('penjaga: non-founder lolos saat sunyi sesudah stabil 5 detik (mode all)', async t => {
  const { guard, advance } = await buatGuard(t, { readConfig: () => ({ ...BASE_CFG, mode: 'all' }) })
  let res = null
  const p = guard.request(reqUser(500)).then(v => { res = v })
  await new Promise(r => setImmediate(r))
  assert.equal(res, null, 'sunyi belum stabil: harus menunggu')
  advance(5000)
  guard.tick()
  await p
  assert.equal(res.granted, true)
})

test('penjaga: non-founder ditolak saat ada unduhan media masuk besar (tidak sunyi)', async t => {
  const { guard } = await buatGuard(t, { readConfig: () => ({ ...BASE_CFG, mode: 'all', userWaitMin: 0 }) })
  const release = guard.noteLight(30 * MB, 'incoming')
  assert.equal((await guard.request(reqUser(500))).reason, 'not-quiet')
  release()
})

test('penjaga: hanya satu kirim besar non-founder dalam satu waktu', async t => {
  const { guard, advance } = await buatGuard(t, { readConfig: () => ({ ...BASE_CFG, mode: 'all' }) })
  const pA = guard.request(reqUser(500, 'UA'))
  advance(5000); guard.tick()
  const a = await pA
  assert.equal(a.granted, true)
  let bRes = null
  const pB = guard.request(reqUser(500, 'UB')).then(v => { bRes = v })
  await new Promise(r => setImmediate(r))
  assert.equal(bRes, null, 'UB harus menunggu selagi slot non-founder terpakai UA')
  guard.release(a.token)
  advance(5000); guard.tick()
  await pB
  assert.equal(bRes.granted, true, 'UB lolos sesudah slot bebas dan sunyi stabil lagi')
})

test('penjaga: anggaran komitmen menolak klaim yang melampaui plafon', async t => {
  const { guard } = await buatGuard(t, { readConfig: () => ({ ...BASE_CFG, mode: 'all', commitCapMB: 600, founderWaitMin: 0, userWaitMin: 0 }) })
  assert.equal((await guard.request(reqFounder(1024))).reason, 'budget')
  assert.equal((await guard.request(reqUser(500))).reason, 'budget')
})

test('penjaga: reservasi kedaluwarsa disapu dan tokennya mati', async t => {
  const { guard, advance, logs } = await buatGuard(t)
  const res = await guard.request(reqFounder(200)) // masa berlaku 2 mnt + 200 dtk
  assert.equal(res.granted, true)
  advance(321 * 1000)
  guard.tick()
  assert.equal(guard.snapshot().reservations.length, 0)
  assert.equal(guard.consume(res.token, 200 * MB), false)
  assert.ok(logs.some(l => l.decision === 'expired'))
})

test('penjaga: penunggu kehabisan batas tunggu ditolak wait-timeout', async t => {
  const { guard, advance } = await buatGuard(t)
  const a = await guard.request(reqFounder(1024, 'FA'))
  assert.equal(a.granted, true)
  const pB = guard.request(reqFounder(1024, 'FB'))
  advance(181 * 1000) // batas tunggu founder 3 menit; A masih aktif (masa berlaku ±19 mnt)
  guard.tick()
  assert.deepEqual(await pB, { granted: false, reason: 'wait-timeout' })
})

test('penjaga: penanda crash saat boot -> mode hati-hati + laporan sekali', async t => {
  const { guard, dir } = await buatGuard(t, { readConfig: () => ({ ...BASE_CFG, mode: 'all' }) })
  await fs.writeFile(path.join(dir, 'send-guard.json'), JSON.stringify({ tok1: { surface: 'downloader/unduh.js', actorClass: 'founder', sizeBytes: 500 * MB, grantedAt: 1 } }))
  const boot = guard.init()
  assert.equal(boot.crash.entries.length, 1)
  await assert.rejects(fs.access(path.join(dir, 'send-guard.json')), 'penanda dibersihkan saat boot')
  assert.equal((await guard.request(reqUser(100))).reason, 'cautious')
  assert.equal((await guard.request(reqFounder(600))).reason, 'over-cap', 'plafon founder dibagi dua saat hati-hati')
  assert.equal((await guard.request(reqFounder(400))).granted, true)
  let text = null
  assert.equal(guard.flushCrashReport(txt => { text = txt }), true)
  assert.match(text, /hati-hati/)
  assert.equal(guard.flushCrashReport(() => {}), false, 'laporan hanya sekali')
})

test('penjaga: tak ada sinyal terbaca -> non-founder ditolak, founder hanya setengah plafon', async t => {
  const { guard } = await buatGuard(t, { readConfig: () => ({ ...BASE_CFG, mode: 'all' }), readSignals: () => ({ memAvailableBytes: null, psiSomeAvg10: null, cgroupHeadroomBytes: null, balloonBytes: null }) })
  assert.equal((await guard.request(reqUser(100))).reason, 'metrics-down')
  assert.equal((await guard.request(reqFounder(600))).reason, 'metrics-down')
  assert.equal((await guard.request(reqFounder(400))).granted, true)
})

test('penjaga: check() — penolakan keras tidak boleh; alasan yang bisa menunggu boleh', async t => {
  const { guard } = await buatGuard(t, { readConfig: () => ({ ...BASE_CFG, mode: 'all' }) })
  const unstable = guard.check(reqUser(500))
  assert.equal(unstable.allowed, true, 'sunyi belum stabil = waitable, pra-cek meloloskan')
  const over = guard.check(reqUser(501))
  assert.equal(over.allowed, false)
  assert.equal(over.reason, 'over-cap')
})

test('penjaga: check() mode founder menolak non-founder secara keras; permukaan tak berhak ditolak', async t => {
  const { guard } = await buatGuard(t)
  const c = guard.check(reqUser(100))
  assert.equal(c.allowed, false)
  assert.equal(c.reason, 'mode-founder-only')
  const { guard: g2 } = await buatGuard(t, { surfaceEntitled: () => false })
  assert.equal(g2.check(reqFounder(100)).reason, 'surface-not-entitled')
})

test('penjaga: VM ber-balloon (available rendah, PSI 0) -> kirim besar LOLOS; bayangan aturan lama tercatat', async t => {
  // Kondisi nyata VM Muse 2026-11-06: balloon 6,1 GB menekan
  // MemAvailable ke ±418 MB, tapi kernel tidak tertekan sama sekali.
  const sinyal = { memAvailableBytes: 418 * MB, psiSomeAvg10: 0, cgroupHeadroomBytes: null, balloonBytes: 6100 * MB }
  const { guard, logs } = await buatGuard(t, { readSignals: () => ({ ...sinyal }) })
  const res = await guard.request(reqFounder(1024))
  assert.equal(res.granted, true, 'balloon bukan tekanan: aturan lama akan menolak, lensa baru meloloskan')
  const granted = logs.find(l => l.decision === 'granted')
  assert.equal(granted.signals.legacyOsLow, true, 'catatan memuat bayangan aturan lama (akan os-low)')
  assert.equal(granted.signals.balloonMB, 6100)
  assert.equal(granted.signals.psiAvg10, 0)
})

test('penjaga: tekanan memori nyata (PSI tinggi) -> ditahan dengan alasan pressure', async t => {
  const sinyal = { memAvailableBytes: 4 * GB, psiSomeAvg10: 12.5, cgroupHeadroomBytes: null, balloonBytes: null }
  const { guard } = await buatGuard(t, { readSignals: () => ({ ...sinyal }), readConfig: () => ({ ...BASE_CFG, founderWaitMin: 0 }) })
  assert.equal((await guard.request(reqFounder(300))).reason, 'pressure')
})

test('penjaga: host sekarat (available di bawah lantai absolut) -> os-low walau PSI 0', async t => {
  const sinyal = { memAvailableBytes: 64 * MB, psiSomeAvg10: 0, cgroupHeadroomBytes: null, balloonBytes: null }
  const { guard } = await buatGuard(t, { readSignals: () => ({ ...sinyal }), readConfig: () => ({ ...BASE_CFG, founderWaitMin: 0 }) })
  assert.equal((await guard.request(reqFounder(300))).reason, 'os-low')
})

test('penjaga: sisa ruang cgroup tidak cukup untuk klaim -> cgroup-low', async t => {
  const sinyal = { memAvailableBytes: 4 * GB, psiSomeAvg10: 0, cgroupHeadroomBytes: 200 * MB, balloonBytes: null }
  const { guard } = await buatGuard(t, { readSignals: () => ({ ...sinyal }), readConfig: () => ({ ...BASE_CFG, founderWaitMin: 0 }) })
  assert.equal((await guard.request(reqFounder(200))).reason, 'cgroup-low', 'klaim 460 MB tidak muat di sisa 200 MB dengan lantai 128 MB')
  assert.equal((await guard.request(reqFounder(30))).granted, true, 'klaim kecil yang muat tetap lolos')
})

test('penjaga: klaim ringan di bawah 25 MB tidak dicatat; di atasnya terlihat dan bisa dilepas', async t => {
  const { guard } = await buatGuard(t)
  guard.noteLight(10 * MB, 'send')
  assert.equal(guard.snapshot().lights.length, 0)
  const release = guard.noteLight(30 * MB, 'send')
  assert.equal(guard.snapshot().lights.length, 1)
  release(); release()
  assert.equal(guard.snapshot().lights.length, 0)
})
