// lib/helpers/sendGuard.js — Penjaga Kirim Besar (2026-11-06, desain dari
// dokumen arsitektur Veo/Claude: Instruksi_Arsitektur_Penjaga_Kirim_File_
// Besar_Sailox.md). Satu-satunya penentu boleh/tidaknya sebuah pengiriman
// file BESAR (> plafon lama 150 MB) memakai RAM sekarang.
//
// Prinsip (sesuai dokumen):
// - Penjaga MEMUTUSKAN, tidak mengirim. Hasilnya reservasi: izin memakai
//   anggaran RAM dengan masa berlaku (lease), ditunjukkan lewat token.
// - Dua lapis: permukaan yang opt-in (metadata bigSend) MEMINTA izin di
//   sini; conn.sendFile MENEGAKKAN (menolak kirim > 150 MB tanpa token
//   reservasi yang sah — lihat lib/simple.js).
// - Pengukuran dua lensa, diambil yang paling pesimistis: buku besar
//   reservasi sendiri dan RSS proses terukur; ditambah lensa sinyal
//   sistem yang bermakna sama di host mana pun: tekanan memori nyata
//   (PSI /proc/pressure/memory), lantai absolut MemAvailable yang kecil
//   (rem darurat host sekarat — BUKAN cadangan besar: MemAvailable
//   mentah menyesatkan di VM ber-balloon, terbukti 2026-11-06 balloon
//   6,1 GB menekan available ke ±418 MB padahal PSI 0,00), dan sisa
//   ruang cgroup bila batasnya terpasang. Tiap sinyal dipakai hanya
//   bila terbaca (deteksi kemampuan, bukan deteksi lingkungan).
// - Founder: sampai 1 GB, tunduk anggaran fisik, tidak wajib sunyi.
//   Non-founder: sampai 500 MB, hanya saat sunyi, satu per satu.
// - Pengiriman <= 150 MB tidak pernah ditolak penjaga; yang >= 25 MB
//   hanya dicatat sebagai klaim ringan (noteLight/noteIncoming) supaya
//   terlihat oleh penilaian "sunyi".
// - Gagal tertutup hanya untuk pengiriman besar: galat internal atau
//   metrik tak terbaca tidak pernah menghalangi pengiriman kecil.
//
// State buku besar murni di memori (proses bot memang volatil di VM ini).
// Yang persisten hanya PENANDA kirim besar aktif di
// src/private/send-guard.json: ditulis saat reservasi diberikan, dihapus
// saat dilepas. Bila saat boot penanda masih berisi, proses sebelumnya
// mati di tengah kirim besar -> mode hati-hati 30 menit (non-founder
// dimatikan, plafon founder dibagi dua) + laporan menunggu dikirim.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const LEGACY_SEND_CAP_BYTES = 150 * 1024 * 1024
export const LIGHT_CLAIM_BYTES = 25 * 1024 * 1024
const MB = 1024 * 1024
const GB = 1024 * MB
const CLAIM_FACTOR = 2.3 // klaim reservasi = ukuran x 2,3 (dokumen bag. 2.3)
const BASELINE_BYTES = 0.5 * GB // asumsi dasar proses bot dalam buku besar
const HARD_FOUNDER_CAP = 1024 * MB
const HARD_USER_CAP = 500 * MB
const QUIET_COMMIT_MAX = 1.0 * GB
const QUIET_LAG_P95_MS = 150
const QUIET_CMD_PER_MIN = 10
const QUIET_STABLE_MS = 5000 // sunyi harus stabil 2 sampel berjarak ±5 dtk
const CAUTIOUS_MS = 30 * 60 * 1000
const WAITABLE = new Set(['budget', 'os-low', 'pressure', 'cgroup-low', 'not-quiet', 'quiet-unstable', 'user-slot-busy'])
const LEGACY_OS_RESERVE_BYTES = 512 * 1024 * 1024 // aturan lama, hanya dihitung sebagai bayangan di catatan keputusan

const DEFAULT_CONFIG = { mode: 'founder', founderCapMB: 1024, userCapMB: 500, founderWaitMin: 3, userWaitMin: 10, commitCapMB: 3500, osReserveMB: 128, pressureMaxPct: 5 }

// Sinyal sistem untuk lensa kedua. Setiap medan boleh null (= tak
// terbaca di host ini); pemanggil memutuskan berdasarkan yang ada.
function defaultReadSignals() {
  const sig = { memAvailableBytes: null, psiSomeAvg10: null, cgroupHeadroomBytes: null, balloonBytes: null }
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8')
    const avail = /^MemAvailable:\s+(\d+) kB/m.exec(info)
    if (avail) sig.memAvailableBytes = Number(avail[1]) * 1024
    const balloon = /^Balloon:\s+(\d+) kB/m.exec(info)
    if (balloon) sig.balloonBytes = Number(balloon[1]) * 1024
  } catch { /* bukan Linux / tak terjangkau */ }
  if (sig.memAvailableBytes == null) { try { sig.memAvailableBytes = os.freemem() } catch { /* tetap null */ } }
  try {
    const m = /^some avg10=([\d.]+)/m.exec(fs.readFileSync('/proc/pressure/memory', 'utf8'))
    if (m) sig.psiSomeAvg10 = Number(m[1])
  } catch { /* kernel tanpa PSI */ }
  try {
    const max = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
    if (max !== 'max') {
      const cur = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim())
      if (Number.isFinite(cur)) sig.cgroupHeadroomBytes = Number(max) - cur
    }
  } catch { /* bukan cgroup v2 / tanpa batas */ }
  return sig
}

function defaultProjectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export function createSendGuard(deps = {}) {
  const now = deps.now ?? (() => Date.now())
  const readRss = deps.readRss ?? (() => process.memoryUsage().rss)
  const readSignals = deps.readSignals ?? defaultReadSignals
  const readConfig = deps.readConfig ?? (() => ({ ...DEFAULT_CONFIG, ...(globalThis.bigsend ?? {}) }))
  const surfaceEntitled = deps.surfaceEntitled ?? (surface => {
    try { return globalThis.pluginLoader?.get?.(surface)?.bigSend === true } catch { return false }
  })
  const subbotWorkers = deps.subbotWorkers ?? (() => globalThis.subBotManager?.workers?.size ?? 0)
  const log = deps.log ?? (() => {})
  const root = deps.root ?? defaultProjectRoot()
  const markerFile = deps.markerFile ?? path.join(root, 'src', 'private', 'send-guard.json')

  const reservations = new Map() // token -> reservasi aktif
  const lights = new Map() // id -> { sizeBytes, kind, at }
  const waiters = [] // { req, cls, resolve, deadline }
  const decisions = [] // cincin 50 keputusan terakhir
  const cmdStamps = [] // cap waktu perintah 60 detik terakhir
  const lagSamples = [] // { at, lag } 60 sampel terakhir
  let cautiousUntil = 0
  let crashInfo = null
  let quietSince = null // sejak kapan syarat sunyi terus terpenuhi
  let sampler = null
  let lastTick = 0
  let lightSeq = 0

  function config() {
    const c = readConfig() ?? {}
    const num = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d
    return {
      mode: ['off', 'founder', 'all'].includes(c.mode) ? c.mode : DEFAULT_CONFIG.mode,
      founderCapMB: Math.min(num(c.founderCapMB, DEFAULT_CONFIG.founderCapMB), HARD_FOUNDER_CAP / MB),
      userCapMB: Math.min(num(c.userCapMB, DEFAULT_CONFIG.userCapMB), HARD_USER_CAP / MB),
      founderWaitMin: Math.max(0, num(c.founderWaitMin, DEFAULT_CONFIG.founderWaitMin)),
      userWaitMin: Math.max(0, num(c.userWaitMin, DEFAULT_CONFIG.userWaitMin)),
      commitCapMB: num(c.commitCapMB, DEFAULT_CONFIG.commitCapMB),
      osReserveMB: Math.min(Math.max(num(c.osReserveMB, DEFAULT_CONFIG.osReserveMB), 32), 2048),
      pressureMaxPct: Math.min(Math.max(num(c.pressureMaxPct, DEFAULT_CONFIG.pressureMaxPct), 1), 100),
    }
  }

  function ledgerClaims() {
    let sum = 0
    for (const r of reservations.values()) sum += r.claimBytes
    for (const l of lights.values()) sum += l.sizeBytes
    return sum
  }

  // Komitmen = terbesar dari (RSS terukur) dan (baseline + semua klaim).
  function commitment() {
    let rss = 0
    try { rss = readRss() } catch { rss = 0 }
    return { rss, ledger: BASELINE_BYTES + ledgerClaims(), total: Math.max(rss, BASELINE_BYTES + ledgerClaims()) }
  }

  function lagP95() {
    if (!lagSamples.length) return 0
    const sorted = lagSamples.map(s => s.lag).sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  }

  function cmdPerMin() {
    const cutoff = now() - 60000
    while (cmdStamps.length && cmdStamps[0] < cutoff) cmdStamps.shift()
    return cmdStamps.length
  }

  function record(entry) {
    decisions.push({ at: now(), ...entry })
    if (decisions.length > 50) decisions.shift()
    try { log(entry) } catch { /* pencatat tidak boleh menjatuhkan penjaga */ }
  }

  let markerDirty = false // true bila berkas penanda mungkin berisi entri yang harus dibersihkan
  function writeMarker() {
    const data = {}
    for (const r of reservations.values()) data[r.token] = { surface: r.surface, actorClass: r.actorClass, sizeBytes: r.sizeBytes, grantedAt: r.grantedAt }
    // Lewati tulis kosong berulang (sweep berjalan tiap detik): berkas
    // hanya ditulis saat ada entri, atau sekali untuk membersihkan sisa.
    if (!Object.keys(data).length && !markerDirty) return
    markerDirty = Object.keys(data).length > 0
    fsp.mkdir(path.dirname(markerFile), { recursive: true })
      .then(() => fsp.writeFile(markerFile, JSON.stringify(data), { mode: 0o600 }))
      .catch(() => { /* penanda gagal tulis tidak menghalangi kirim; mode hati-hati hanya bonus */ })
  }

  function classify(req) {
    let roles = {}
    try { roles = req.roleOf?.(req.actor) ?? {} } catch { roles = {} }
    return roles.isFounder ? 'founder' : 'user'
  }

  function capFor(cls, cfg) {
    let cap = (cls === 'founder' ? cfg.founderCapMB : cfg.userCapMB) * MB
    if (now() < cautiousUntil && cls === 'founder') cap = Math.floor(cap / 2)
    return cap
  }

  // Penilaian sinkron murni terhadap state saat ini. Mengembalikan
  // { ok: true, cls, claimBytes } atau { ok: false, reason, cls }.
  function evaluate(req) {
    const cfg = config()
    const cls = classify(req)
    const size = req.sizeBytes
    if (!Number.isFinite(size) || size <= 0) return { ok: false, reason: 'bad-size', cls }
    if (cfg.mode === 'off') return { ok: false, reason: 'mode-off', cls }
    if (cls === 'user' && cfg.mode === 'founder') return { ok: false, reason: 'mode-founder-only', cls }
    if (size > capFor(cls, cfg)) return { ok: false, reason: 'over-cap', cls }
    if (now() < cautiousUntil && cls === 'user') return { ok: false, reason: 'cautious', cls }
    for (const r of reservations.values()) if (r.actor === req.actor) return { ok: false, reason: 'actor-busy', cls }
    for (const w of waiters) if (w.req.actor === req.actor) return { ok: false, reason: 'actor-busy', cls }
    const claimBytes = Math.ceil(size * CLAIM_FACTOR)
    const commit = commitment()
    if (commit.total + claimBytes > cfg.commitCapMB * MB) return { ok: false, reason: 'budget', cls, commit }
    const raw = readSignals() ?? {}
    const sig = {
      availMB: raw.memAvailableBytes != null ? Math.round(raw.memAvailableBytes / MB) : null,
      psiAvg10: raw.psiSomeAvg10 ?? null,
      balloonMB: raw.balloonBytes != null ? Math.round(raw.balloonBytes / MB) : null,
      cgHeadroomMB: raw.cgroupHeadroomBytes != null ? Math.round(raw.cgroupHeadroomBytes / MB) : null,
      // Bayangan aturan lama (cadangan MemAvailable 512 MB): dihitung
      // terus di catatan keputusan supaya perbedaan perilaku lensa baru
      // vs lama terlihat di log, tanpa menegakkan dua aturan sekaligus.
      legacyOsLow: raw.memAvailableBytes != null ? raw.memAvailableBytes - claimBytes < LEGACY_OS_RESERVE_BYTES : null,
    }
    const anySignal = raw.memAvailableBytes != null || raw.psiSomeAvg10 != null || raw.cgroupHeadroomBytes != null
    if (!anySignal) {
      // Tak ada sinyal sistem yang terbaca = tidak tahu = konservatif
      // (dokumen 7): non-founder ditolak; founder hanya setengah plafon.
      if (cls === 'user') return { ok: false, reason: 'metrics-down', cls, commit, sig }
      if (size > Math.floor(capFor(cls, cfg) / 2)) return { ok: false, reason: 'metrics-down', cls, commit, sig }
    } else {
      // Lantai MemAvailable bersifat ABSOLUT (bukan dikurangi klaim):
      // available adalah artefak akuntansi host (balloon!), bukan kolam
      // tempat klaim dialokasikan — biaya klaim sudah dijaga lensa
      // anggaran + PSI. Lantai hanya rem darurat host yang benar-benar
      // sekarat. Sisa ruang cgroup berbeda: itu kolam nyata proses ini,
      // jadi di sana klaim memang dikurangkan.
      if (raw.memAvailableBytes != null && raw.memAvailableBytes < cfg.osReserveMB * MB) return { ok: false, reason: 'os-low', cls, commit, sig }
      if (raw.psiSomeAvg10 != null && raw.psiSomeAvg10 >= cfg.pressureMaxPct) return { ok: false, reason: 'pressure', cls, commit, sig }
      if (raw.cgroupHeadroomBytes != null && raw.cgroupHeadroomBytes - claimBytes < cfg.osReserveMB * MB) return { ok: false, reason: 'cgroup-low', cls, commit, sig }
    }
    if (cls === 'user') {
      if ([...reservations.values()].some(r => r.actorClass === 'user')) return { ok: false, reason: 'user-slot-busy', cls, commit, sig }
      const incomingBig = [...lights.values()].some(l => l.kind === 'incoming' && l.sizeBytes > LIGHT_CLAIM_BYTES)
      const quiet = reservations.size === 0 && lights.size === 0 && !incomingBig &&
        subbotWorkers() === 0 && commit.total <= QUIET_COMMIT_MAX &&
        lagP95() <= QUIET_LAG_P95_MS && cmdPerMin() <= QUIET_CMD_PER_MIN
      if (!quiet) { quietSince = null; return { ok: false, reason: 'not-quiet', cls, commit, sig } }
      if (quietSince == null) { quietSince = now(); return { ok: false, reason: 'quiet-unstable', cls, commit, sig } }
      if (now() - quietSince < QUIET_STABLE_MS) return { ok: false, reason: 'quiet-unstable', cls, commit, sig }
    }
    return { ok: true, cls, claimBytes, commit, sig }
  }

  function grant(req, ev) {
    const token = randomUUID()
    const leaseMs = Math.min(30 * 60 * 1000, 2 * 60 * 1000 + Math.ceil(req.sizeBytes / MB) * 1000)
    const r = {
      token, surface: req.surface, actor: req.actor, actorClass: ev.cls,
      sizeBytes: req.sizeBytes, claimBytes: ev.claimBytes,
      grantedAt: now(), expiresAt: now() + leaseMs, consumed: false, peakRss: 0,
    }
    reservations.set(token, r)
    writeMarker()
    record({ decision: 'granted', surface: req.surface, actorClass: ev.cls, sizeBytes: req.sizeBytes, claimBytes: ev.claimBytes, commitmentBefore: ev.commit?.total ?? null, signals: ev.sig ?? null })
    return { granted: true, token, expiresAt: r.expiresAt }
  }

  function processWaiters() {
    if (!waiters.length) return
    // Founder didahulukan, selebihnya FIFO (dokumen 2.6).
    waiters.sort((a, b) => (a.cls === b.cls ? a.enqueuedAt - b.enqueuedAt : a.cls === 'founder' ? -1 : 1))
    const settle = w => { if (w.timer) { clearTimeout(w.timer); w.timer = null } }
    for (let i = 0; i < waiters.length;) {
      const w = waiters[i]
      if (now() > w.deadline) {
        waiters.splice(i, 1)
        settle(w)
        record({ decision: 'denied', surface: w.req.surface, actorClass: w.cls, sizeBytes: w.req.sizeBytes, reason: 'wait-timeout' })
        w.resolve({ granted: false, reason: 'wait-timeout' })
        continue
      }
      // Keluarkan dulu dari antrean selama dinilai ulang: evaluate()
      // menghitung penunggu lain sebagai aktor sibuk, dan penunggu ini
      // tidak boleh menabrak dirinya sendiri.
      waiters.splice(i, 1)
      const ev = evaluate(w.req)
      if (ev.ok) {
        settle(w)
        w.resolve(grant(w.req, ev))
        continue // sesudah satu pemberian, nilai ulang dari awal antrean
      }
      if (!WAITABLE.has(ev.reason)) {
        settle(w)
        record({ decision: 'denied', surface: w.req.surface, actorClass: w.cls, sizeBytes: w.req.sizeBytes, reason: ev.reason, signals: ev.sig ?? null })
        w.resolve({ granted: false, reason: ev.reason })
        continue
      }
      waiters.splice(i, 0, w) // masih menunggu: kembalikan ke posisinya
      i++
    }
  }

  function sweep() {
    const t = now()
    for (const r of [...reservations.values()]) {
      if (t > r.expiresAt) {
        reservations.delete(r.token)
        record({ decision: 'expired', surface: r.surface, actorClass: r.actorClass, sizeBytes: r.sizeBytes, reason: 'lease-expired' })
      }
    }
    if (reservations.size === 0) writeMarker()
    processWaiters()
  }

  // ─── API publik ────────────────────────────────────────────────────────

  // Minta reservasi kirim besar. Mengembalikan Promise:
  // { granted: true, token, expiresAt } | { granted: false, reason }.
  // Penolakan non-waitable (mode, plafon, aktor sibuk, mode hati-hati,
  // metrik mati) bersifat langsung; sisanya menunggu sampai batas tunggu
  // kelas pelaku. Keputusan & pencatatan awal sinkron (satu langkah,
  // tanpa jeda async) supaya dua permintaan tak bisa sama-sama lolos.
  function request(req) {
    if (!surfaceEntitled(req?.surface)) return Promise.resolve({ granted: false, reason: 'surface-not-entitled' })
    sweep()
    const ev = evaluate(req)
    if (ev.ok) return Promise.resolve(grant(req, ev))
    if (!WAITABLE.has(ev.reason)) {
      record({ decision: 'denied', surface: req.surface, actorClass: ev.cls, sizeBytes: req.sizeBytes, reason: ev.reason, signals: ev.sig ?? null })
      return Promise.resolve({ granted: false, reason: ev.reason })
    }
    const cfg = config()
    const waitMin = ev.cls === 'founder' ? cfg.founderWaitMin : cfg.userWaitMin
    if (waitMin <= 0) {
      record({ decision: 'denied', surface: req.surface, actorClass: ev.cls, sizeBytes: req.sizeBytes, reason: ev.reason, signals: ev.sig ?? null })
      return Promise.resolve({ granted: false, reason: ev.reason })
    }
    record({ decision: 'deferred', surface: req.surface, actorClass: ev.cls, sizeBytes: req.sizeBytes, reason: ev.reason, signals: ev.sig ?? null })
    return new Promise(resolve => {
      const w = { req, cls: ev.cls, resolve, deadline: now() + waitMin * 60000, enqueuedAt: now(), timer: null }
      waiters.push(w)
      // Jaring pengaman tenggat: janji penunggu HARUS selesai walau tak
      // ada perubahan state dan sampler belum berjalan (mis. proses uji);
      // di produksi sampler 1 detik biasanya memproses jauh lebih awal.
      w.timer = setTimeout(() => processWaiters(), waitMin * 60000 + 10)
      w.timer.unref?.()
    })
  }

  // Pra-cek tanpa memesan: dipakai permukaan yang harus tahu boleh/tidak
  // SEBELUM pekerjaan mahal dimulai (alur anime: jangan unduh file yang
  // pasti ditolak penjaga). Alasan yang masih bisa berubah seiring waktu
  // (anggaran, sunyi, slot) dihitung BOLEH — keputusan final tetap dibuat
  // request() di titik kirim. Penolakan keras dicatat sebagai keputusan.
  function check(req) {
    if (!surfaceEntitled(req?.surface)) return { allowed: false, reason: 'surface-not-entitled', actorClass: null }
    const ev = evaluate(req)
    const allowed = ev.ok || WAITABLE.has(ev.reason)
    if (!allowed) record({ decision: 'precheck-denied', surface: req.surface, actorClass: ev.cls, sizeBytes: req.sizeBytes, reason: ev.reason, signals: ev.sig ?? null })
    return { allowed, reason: ev.ok ? null : ev.reason, actorClass: ev.cls }
  }

  // Dipanggil conn.sendFile sebelum membaca file > plafon lama: token
  // harus ada, belum kedaluwarsa, belum dipakai, dan ukuran sebenarnya
  // tidak melebihi yang dipesan. Sekali pakai.
  function consume(token, actualSizeBytes) {
    const r = reservations.get(token)
    if (!r || r.consumed) return false
    if (now() > r.expiresAt) return false
    if (!Number.isFinite(actualSizeBytes) || actualSizeBytes > r.sizeBytes) return false
    r.consumed = true
    return true
  }

  // Lepas reservasi (semua jalur keluar permukaan peminta: sukses/gagal).
  function release(token) {
    const r = reservations.get(token)
    if (!r) return false
    reservations.delete(token)
    record({ decision: 'released', surface: r.surface, actorClass: r.actorClass, sizeBytes: r.sizeBytes, peakRss: r.peakRss || null })
    writeMarker()
    processWaiters()
    return true
  }

  // Klaim ringan untuk pengiriman 25–150 MB & unduhan media masuk:
  // hanya dicatat supaya penilaian sunyi melihatnya. Mengembalikan
  // fungsi lepas yang idempoten.
  function noteLight(sizeBytes, kind = 'send') {
    if (!Number.isFinite(sizeBytes) || sizeBytes < LIGHT_CLAIM_BYTES) return () => {}
    const id = ++lightSeq
    lights.set(id, { sizeBytes, kind, at: now() })
    let done = false
    return () => { if (!done) { done = true; lights.delete(id); processWaiters() } }
  }

  function noteCommand() {
    cmdStamps.push(now())
    cmdPerMin()
  }

  // Boot: baca penanda crash, nyalakan sampler (lag event loop + sapu
  // berkala). Mengembalikan { crash } — crash berisi daftar kirim besar
  // yang sedang berjalan saat proses sebelumnya mati (bila ada).
  function init() {
    let crash = null
    try {
      const raw = fs.readFileSync(markerFile, 'utf8')
      const entries = Object.values(JSON.parse(raw) ?? {})
      if (entries.length) {
        crash = { entries, detectedAt: now() }
        crashInfo = crash
        cautiousUntil = now() + CAUTIOUS_MS
      }
      fs.rmSync(markerFile, { force: true })
    } catch (e) { if (e.code !== 'ENOENT') record({ decision: 'marker-unreadable', reason: String(e?.code ?? e) }) }
    if (!sampler) {
      lastTick = now()
      sampler = setInterval(tick, 1000)
      sampler.unref?.()
    }
    return { crash }
  }

  // Satu langkah sampler: catat jeda event loop, perbarui RSS puncak
  // reservasi, lalu sapu kedaluwarsa + proses antrean tunggu. Dipanggil
  // interval 1 detik dari init(); diekspos juga untuk pengujian.
  function tick() {
    const t = now()
    if (lastTick) {
      lagSamples.push({ at: t, lag: Math.max(0, t - lastTick - 1000) })
      if (lagSamples.length > 60) lagSamples.shift()
    }
    lastTick = t
    let rss = 0
    try { rss = readRss() } catch { /* abaikan */ }
    for (const r of reservations.values()) if (rss > r.peakRss) r.peakRss = rss
    sweep()
  }

  // Laporan crash boot (bila ada) dikirim sekali lewat notify founder.
  function flushCrashReport(notify) {
    if (!crashInfo || typeof notify !== 'function') return false
    const info = crashInfo
    crashInfo = null
    const lines = info.entries.map(e => `• ${e.surface} — ${(e.sizeBytes / MB).toFixed(1)} MB (${e.actorClass})`)
    notify(`⚠️ Bot mati di tengah pengiriman file besar (${info.entries.length} kirim aktif saat proses sebelumnya berhenti). Job terkait TIDAK diulang lewat jalur besar. Mode hati-hati aktif 30 menit: kirim besar non-founder mati, plafon founder setengah.\n${lines.join('\n')}`)
    return true
  }

  function snapshot() {
    return {
      config: config(),
      cautiousUntil,
      commitment: commitment(),
      reservations: [...reservations.values()].map(r => ({ surface: r.surface, actorClass: r.actorClass, sizeBytes: r.sizeBytes, expiresAt: r.expiresAt, consumed: r.consumed })),
      waiters: waiters.length,
      lights: [...lights.values()],
      decisions: decisions.slice(-10),
    }
  }

  return { request, check, consume, release, noteLight, noteCommand, init, tick, flushCrashReport, snapshot, _state: { reservations, waiters, lights } }
}

// Singleton proses utama + pembungkus bernama untuk pemanggil.
export const sendGuard = createSendGuard()
export const requestBigSend = req => sendGuard.request(req)
export const checkBigSend = req => sendGuard.check(req)
export const releaseBigSend = token => sendGuard.release(token)
export const consumeBigSend = (token, size) => sendGuard.consume(token, size)
export const noteLightSend = (size, kind) => sendGuard.noteLight(size, kind)
export const noteGuardCommand = () => sendGuard.noteCommand()
export const initSendGuard = () => sendGuard.init()
