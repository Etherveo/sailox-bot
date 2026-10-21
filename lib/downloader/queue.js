// lib/downloader/queue.js
//
// Antrean unduhan anti-spam BERBASIS FILE JSON (permintaan pemilik: jangan
// simpan antrean di RAM). Seluruh state antrean hidup di satu file JSON
// (default: src/download-queue.json) dan ditulis ULANG SECARA ATOMIK
// (file sementara + rename) setiap ada perubahan status — jadi:
//  - Restart/crash di tengah jalan tidak menghilangkan antrean; job yang
//    tertinggal berstatus 'active' dikembalikan ke 'pending' saat file
//    dimuat lagi (resume, diunduh ulang dari awal oleh prosesor).
//  - Memori proses hanya memegang salinan sesaat saat membaca/menulis file
//    (file-nya sendiri kecil: riwayat selesai dibatasi).
//
// Modul ini TIDAK tahu apa-apa soal WhatsApp/engine: pekerjaan sebenarnya
// dijalankan fungsi `processJob(job)` yang diinjeksi pemanggil, dan kegagalan
// prosesor dengan kode 'NO_CONN' berarti "belum ada koneksi WA yang bisa
// dipakai" — job dikembalikan ke pending dan pump berhenti sampai kick()
// dipanggil lagi (plugin .download memanggil kick setiap ada perintah baru,
// sekalian menyerahkan conn terbaru).
//
// Batas anti-spam (default): maksimal 2 unduhan berjalan bersamaan, 1 per
// pengguna pada satu waktu, 3 job menunggu per pengguna, 50 total pending.

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const QUEUE_DEFAULTS = { maxConcurrent: 2, maxActivePerUser: 1, maxPendingPerUser: 3, maxPendingTotal: 50, keepFinished: 20 }

export function createDownloadQueue({ file, processJob, ...limits } = {}) {
  if (!file) throw new Error('createDownloadQueue butuh path file JSON antrean.')
  if (typeof processJob !== 'function') throw new Error('createDownloadQueue butuh fungsi processJob.')
  const cfg = { ...QUEUE_DEFAULTS, ...limits }
  const filePath = path.resolve(file)
  let writeChain = Promise.resolve()
  let pumping = false
  let activeCount = 0

  async function load() {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
      if (parsed && Array.isArray(parsed.jobs)) return parsed
    } catch { /* file belum ada / rusak -> mulai dari antrean kosong */ }
    return { seq: 0, jobs: [] }
  }

  async function save(state) {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(state, null, 1))
    await fs.rename(tmp, filePath)
  }

  // Semua mutasi dilewatkan rantai ini agar tidak saling menimpa.
  function mutate(fn) {
    const run = writeChain.then(async () => {
      const state = await load()
      const out = await fn(state)
      trimFinished(state)
      await save(state)
      return out
    })
    writeChain = run.catch(() => {})
    return run
  }

  function trimFinished(state) {
    const finished = state.jobs.filter(j => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')
    if (finished.length <= cfg.keepFinished) return
    const drop = new Set(finished.slice(0, finished.length - cfg.keepFinished).map(j => j.id))
    state.jobs = state.jobs.filter(j => !drop.has(j.id))
  }

  const pendingOf = (state, sender) => state.jobs.filter(j => j.status === 'pending' && (sender === undefined || j.sender === sender))

  async function enqueue(input) {
    return mutate(state => {
      if (pendingOf(state).length >= cfg.maxPendingTotal) throw new Error(`Antrean unduhan penuh (${cfg.maxPendingTotal} job menunggu). Coba lagi nanti.`)
      if (pendingOf(state, input.sender).length >= cfg.maxPendingPerUser) throw new Error(`Kamu sudah punya ${cfg.maxPendingPerUser} unduhan yang menunggu di antrean. Tunggu sampai selesai dulu, ya.`)
      const job = {
        id: ++state.seq,
        url: input.url,
        provider: input.provider,
        chat: input.chat,
        sender: input.sender,
        senderName: input.senderName ?? '',
        status: 'pending',
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        fileName: null,
        size: null,
        error: null,
      }
      state.jobs.push(job)
      return { job: { ...job }, position: pendingOf(state).length }
    }).then(out => { void pump(); return out })
  }

  async function snapshot() {
    const state = await load()
    return {
      jobs: state.jobs.map(j => ({ ...j })),
      pending: state.jobs.filter(j => j.status === 'pending').length,
      active: state.jobs.filter(j => j.status === 'active').length,
    }
  }

  async function cancel(id, sender) {
    return mutate(state => {
      const job = state.jobs.find(j => j.id === Number(id))
      if (!job) throw new Error(`Job #${id} tidak ditemukan.`)
      if (job.sender !== sender) throw new Error('Itu bukan antrean milikmu.')
      if (job.status !== 'pending') throw new Error(`Job #${id} sudah berstatus ${job.status}, tidak bisa dibatalkan.`)
      job.status = 'cancelled'
      job.finishedAt = new Date().toISOString()
      return { ...job }
    })
  }

  // Ambil job pending berikutnya yang pengirimnya belum mencapai batas
  // unduhan aktif; tandai active. Mengembalikan null bila tidak ada.
  async function claimNext() {
    return mutate(state => {
      // Pulihkan job yatim (proses mati saat active) lebih dulu.
      let recovered = false
      if (activeCount === 0) {
        for (const j of state.jobs) if (j.status === 'active') { j.status = 'pending'; j.startedAt = null; recovered = true }
      }
      const activeBySender = new Map()
      for (const j of state.jobs) if (j.status === 'active') activeBySender.set(j.sender, (activeBySender.get(j.sender) ?? 0) + 1)
      const next = state.jobs.find(j => j.status === 'pending' && (activeBySender.get(j.sender) ?? 0) < cfg.maxActivePerUser)
      if (!next) return null
      next.status = 'active'
      next.startedAt = new Date().toISOString()
      if (recovered) next.error = null
      return { ...next }
    })
  }

  async function finish(id, patch) {
    return mutate(state => {
      const job = state.jobs.find(j => j.id === id)
      if (!job) return
      Object.assign(job, patch, { finishedAt: new Date().toISOString() })
    })
  }

  async function runJob(job) {
    try {
      const result = await processJob(job)
      await finish(job.id, { status: 'done', fileName: result?.fileName ?? null, size: result?.size ?? null, error: null })
    } catch (e) {
      if (e?.code === 'NO_CONN') {
        // Belum ada koneksi: kembalikan ke pending TANPA menghitung gagal,
        // dan jangan memompa lagi sampai ada kick() (perintah .dl berikutnya
        // akan menyerahkan conn terbaru lalu memanggil kick).
        await finish(job.id, { status: 'pending', startedAt: null, finishedAt: null })
        activeCount--
        return
      }
      await finish(job.id, { status: 'failed', error: String(e?.message ?? e).slice(0, 300) })
    }
    activeCount--
    void pump()
  }

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (activeCount < cfg.maxConcurrent) {
        const job = await claimNext()
        if (!job) break
        activeCount++
        void runJob(job)
      }
    } finally { pumping = false }
  }

  return {
    file: filePath,
    enqueue,
    snapshot,
    cancel,
    kick: () => pump(),
    get activeCount() { return activeCount },
  }
}

// ─── Singleton untuk bot utama ──────────────────────────────────────────────
// processJob dipasang oleh plugin .download (yang memegang akses conn) lewat
// attachDownloadProcessor(); sebelum itu, job hanya menumpuk sebagai pending.
let singleton = null
let processor = null

export function attachDownloadProcessor(fn) {
  processor = fn
  singleton?.kick()
}

export function getDownloadQueue(rootDir) {
  if (!singleton) {
    singleton = createDownloadQueue({
      file: path.join(rootDir, 'src', 'download-queue.json'),
      processJob: async job => {
        if (!processor) { const e = new Error('Prosesor unduhan belum terpasang.'); e.code = 'NO_CONN'; throw e }
        return processor(job)
      },
    })
  }
  return singleton
}
