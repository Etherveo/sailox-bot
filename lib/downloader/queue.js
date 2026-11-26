// lib/downloader/queue.js
//
// Antrean unduhan anti-spam BERBASIS FILE JSON (permintaan pemilik: jangan
// simpan antrean di RAM). Seluruh state antrean hidup di satu file JSON
// (default: src/download-queue.json) dan ditulis ULANG SECARA ATOMIK
// (file sementara + rename) setiap ada perubahan status — jadi:
//  - Restart/crash di tengah jalan tidak menghilangkan antrean; job yang
//    tertinggal berstatus 'active' dikembalikan ke 'pending' saat file
//    dimuat lagi (resume, diunduh ulang dari awal oleh prosesor).
//  - Job yang SELESAI diproses (done/failed) atau dibatalkan langsung
//    DIHAPUS dari file (permintaan pemilik 2026-10-24: antrean harus
//    dibersihkan setelah selesai) — file hanya menyimpan job yang masih
//    hidup (pending/active) plus nomor urut `seq` yang terus naik agar
//    nomor antrean tidak pernah dipakai ulang.
//  - Memori proses hanya memegang salinan sesaat saat membaca/menulis file.
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
import { ensureDir } from '../helpers/ensureDir.js'

export const QUEUE_DEFAULTS = { maxConcurrent: 2, maxActivePerUser: 1, maxPendingPerUser: 3, maxPendingTotal: 50, duplicateCooldownMs: 60_000 }
// Klaim MANUAL (.tt): job yang dititipkan ke antrean hanya sebagai penanda
// dedupe/batas (diproses pemiliknya sendiri, bukan pump .dl). Pump melewati
// klaim manual; klaim yang tidak di-finish (proses mati) kedaluwarsa agar
// tidak memblokir link selamanya.
export const MANUAL_CLAIM_TTL_MS = 10 * 60 * 1000

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
      if (parsed && Array.isArray(parsed.jobs)) {
        if (!Array.isArray(parsed.recent)) parsed.recent = []
        return parsed
      }
    } catch { /* file belum ada / rusak -> mulai dari antrean kosong */ }
    return { seq: 0, jobs: [], recent: [] }
  }

  // Daftar cooldown dedupe: link yang baru keluar dari antrean (selesai /
  // gagal / batal) tidak boleh diproses lagi selama duplicateCooldownMs.
  // Entri kedaluwarsa dibuang tiap akses; daftar dibatasi 200 terbaru.
  function pruneRecent(state, now = Date.now()) {
    state.recent = (state.recent ?? []).filter(r => r.until > now).slice(-200)
  }

  async function save(state) {
    await ensureDir(path.dirname(filePath))
    // Nama tmp UNIK per save (bukan cuma per pid): dua instance antrean
    // pada file yang sama bisa menyimpan bersamaan — dengan tmp yang sama,
    // rename pertama memindahkan tmp lalu rename kedua gagal ENOENT.
    // Di Linux balapan ini jarang kena; di Windows yang FS-nya lebih
    // lambat ia sering kena (tes .dl di Windows gagal persis begini).
    const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    // Rename atomik di Windows bisa gagal EPERM/EBUSY bila file sedang
    // dikunci (mis. pemindai antivirus) — coba lagi beberapa kali dengan
    // jeda singkat sebelum menyerah. Di Linux rename tidak pernah gagal
    // begini, jadi retry ini no-op di sana.
    let lastError
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.writeFile(tmp, JSON.stringify(state, null, 1))
        await fs.rename(tmp, filePath)
        return
      } catch (e) {
        lastError = e
        if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e
        await new Promise(r => setTimeout(r, 25 * (attempt + 1)))
      }
    }
    throw lastError
  }

  // Semua mutasi dilewatkan rantai ini agar tidak saling menimpa.
  // Bila fn tidak mengubah state (mis. klaim yang tidak menemukan job),
  // file TIDAK ditulis ulang: save percuma itu yang jadi sumber balapan
  // cleanup di tes (save latar menyusul setelah direktori temp dihapus)
  // dan tulis disk sia-sia di setiap pass pompa bot.
  function mutate(fn) {
    const run = writeChain.then(async () => {
      const state = await load()
      const before = JSON.stringify(state)
      const out = await fn(state)
      if (JSON.stringify(state) !== before) await save(state)
      return out
    })
    writeChain = run.catch(() => {})
    return run
  }

  const pendingOf = (state, sender) => state.jobs.filter(j => j.status === 'pending' && (sender === undefined || j.sender === sender))

  async function enqueue(input) {
    return mutate(state => {
      const now = Date.now()
      pruneRecent(state, now)
      // Klaim manual kedaluwarsa dibuang dulu — bila tidak, proses yang mati
      // sebelum finish akan memblokir link itu selamanya di dedupe bawah.
      state.jobs = state.jobs.filter(j => !(j.manual && j.expiresAt && j.expiresAt <= now))
      if (pendingOf(state).length >= cfg.maxPendingTotal) throw `Antrean unduhan penuh (${cfg.maxPendingTotal} job menunggu). Coba lagi nanti.`
      if (pendingOf(state, input.sender).length >= cfg.maxPendingPerUser) throw `Kamu sudah punya ${cfg.maxPendingPerUser} unduhan yang menunggu di antrean. Tunggu sampai selesai dulu, ya.`
      // Link yang sama tidak boleh diproses dua kali: masih mengantri ->
      // tolak; baru keluar dari antrean -> masih dalam masa cooldown.
      // Pengecualian: pick dari sesi interaktif (sessionPick) melewati
      // cooldown — user boleh memilih ulang item yang baru selesai —
      // tapi dedupe saat masih mengantri tetap berlaku.
      const live = state.jobs.find(j => (j.status === 'pending' || j.status === 'active') && j.url === input.url)
      if (live) throw `Link ini sudah ada di antrean #${live.id}.`
      const cooled = (state.recent ?? []).find(r => r.url === input.url)
      if (cooled && !input.sessionPick) throw `Link ini baru saja diproses — bisa diproses lagi dalam ${Math.ceil((cooled.until - now) / 1000)} detik.`
      const job = {
        id: ++state.seq,
        url: input.url,
        provider: input.provider,
        chat: input.chat,
        sender: input.sender,
        senderName: input.senderName ?? '',
        userMsgKey: input.userMsgKey ?? null,
        queueNoticeKey: null,
        manual: !!input.manual,
        expiresAt: input.expiresAt ?? (input.manual ? now + MANUAL_CLAIM_TTL_MS : null),
        // options: objek serializable yang mengalir plugin -> antrean ->
        // prosesor (lihat runJob: { pickSession } membuka sesi pilih saat
        // hasil list muncul). BUKAN function — antrean persist di JSON.
        options: input.options ?? null,
        // sessionPick: job ini berasal dari pick sesi interaktif.
        sessionPick: !!input.sessionPick,
        // batch: job unduh-semua ({ name, items: [{ index, fileName,
        // size }], progress: { done, failed, kept } }) — progres ditulis
        // per item oleh prosesor supaya interupsi bisa dilanjutkan.
        batch: input.batch ?? null,
        status: 'pending',
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        fileName: null,
        size: null,
        error: null,
      }
      state.jobs.push(job)
      // Posisi = peringkat di antara SEMUA job yang masih hidup (aktif +
      // menunggu), bukan cuma yang pending — job yang sedang diunduh pun
      // tetap menghalangi giliran di depannya.
      const liveCount = state.jobs.filter(j => j.status === 'pending' || j.status === 'active').length
      return { job: { ...job }, position: liveCount, liveCount }
    }).then(out => { void pump(); return out })
  }

  // Catat kunci pesan pemberitahuan posisi antrean (untuk dihapus setelah
  // job selesai) — dipanggil plugin sesaat setelah antrean dibuat.
  async function updateNotice(id, key) {
    return mutate(state => {
      const job = state.jobs.find(j => j.id === Number(id))
      if (!job) throw new Error(`Job #${id} tidak ditemukan.`)
      job.queueNoticeKey = key ?? null
      return { ...job }
    })
  }

  // Perbarui field job yang masih hidup tanpa mengubah statusnya
  // (dipakai prosesor batch untuk menulis progres per item). Tidak
  // menyentuh finishedAt — itu urusan finish().
  async function update(id, patch) {
    return mutate(state => {
      const job = state.jobs.find(j => j.id === Number(id))
      if (!job) throw new Error(`Job #${id} tidak ditemukan.`)
      Object.assign(job, patch)
      return { ...job }
    })
  }

  async function snapshot() {
    const state = await load()
    // Cooldown kedaluwarsa tidak ditampilkan (hanya disaring di salinan
    // ini — file tidak ditulis ulang di sini).
    pruneRecent(state)
    return {
      jobs: state.jobs.map(j => ({ ...j })),
      pending: state.jobs.filter(j => j.status === 'pending').length,
      active: state.jobs.filter(j => j.status === 'active').length,
      recent: (state.recent ?? []).map(r => ({ ...r })),
    }
  }

  async function cancel(id, sender) {
    return mutate(state => {
      const job = state.jobs.find(j => j.id === Number(id))
      if (!job) throw `Job #${id} tidak ditemukan.`
      if (job.sender !== sender) throw 'Itu bukan antrean milikmu.'
      if (job.status !== 'pending') throw `Job #${id} sudah berstatus ${job.status}, tidak bisa dibatalkan.`
      job.status = 'cancelled'
      job.finishedAt = new Date().toISOString()
      state.jobs = state.jobs.filter(j => j.id !== job.id)
      state.recent = [...(state.recent ?? []), { url: job.url, until: Date.now() + cfg.duplicateCooldownMs }]
      pruneRecent(state)
      return { ...job }
    })
  }

  // Klaim SEMUA slot kosong yang bisa diisi dalam SATU mutasi (bukan satu
  // mutasi per klaim). Di FS yang lambat (Windows), satu save bisa lebih
  // lama dari job 10 ms di tes — klaim berikutnya telat, job yang
  // seharusnya menyalip malah baru mulai setelah job sebelumnya selesai
  // (tes antrean gagal persis begini). Satu save per pass juga mengurangi
  // tulis disk di bot. Mengembalikan [] bila tidak ada yang bisa diklaim.
  async function claimAvailable() {
    return mutate(state => {
      // Pulihkan job yatim (proses mati saat active) lebih dulu.
      let recovered = false
      if (activeCount === 0) {
        for (const j of state.jobs) if (j.status === 'active') { j.status = 'pending'; j.startedAt = null; recovered = true }
      }
      const activeBySender = new Map()
      for (const j of state.jobs) if (j.status === 'active') activeBySender.set(j.sender, (activeBySender.get(j.sender) ?? 0) + 1)
      const claimed = []
      while (activeCount + claimed.length < cfg.maxConcurrent) {
        const next = state.jobs.find(j => j.status === 'pending' && !j.manual && (activeBySender.get(j.sender) ?? 0) < cfg.maxActivePerUser)
        if (!next) break
        next.status = 'active'
        next.startedAt = new Date().toISOString()
        if (recovered) next.error = null
        activeBySender.set(next.sender, (activeBySender.get(next.sender) ?? 0) + 1)
        claimed.push({ ...next })
      }
      return claimed
    })
  }

  async function finish(id, patch) {
    return mutate(state => {
      const job = state.jobs.find(j => j.id === id)
      if (!job) return
      // Selesai = langsung keluar dari antrean (lihat catatan di header)
      // dan masuk masa cooldown dedupe 1 menit.
      // Patch berstatus lain (mis. 'pending' untuk NO_CONN) hanya memperbarui.
      if (patch.status === 'done' || patch.status === 'failed') {
        state.jobs = state.jobs.filter(j => j.id !== id)
        state.recent = [...(state.recent ?? []), { url: job.url, until: Date.now() + cfg.duplicateCooldownMs }]
        pruneRecent(state)
        return
      }
      Object.assign(job, patch, { finishedAt: new Date().toISOString() })
    })
  }

  // Kosongkan antrean untuk pengujian/pemeliharaan (perintah owner
  // .clearqueue): hapus semua job pending (termasuk klaim manual .tt)
  // dan seluruh daftar cooldown recent. Job yang sedang aktif DIBIARKAN —
  // unduhannya sudah berjalan dan tidak bisa dibatalkan dari file antrean;
  // jumlahnya dilaporkan agar pemanggil tahu. Nomor urut `seq` TIDAK
  // direset (nomor antrean tidak pernah dipakai ulang).
  async function clearQueue() {
    return mutate(state => {
      pruneRecent(state)
      const manual = state.jobs.filter(j => j.manual).length
      const pending = state.jobs.filter(j => j.status === 'pending' && !j.manual).length
      const recent = (state.recent ?? []).length
      const active = state.jobs.filter(j => j.status === 'active').length
      state.jobs = state.jobs.filter(j => j.status === 'active')
      state.recent = []
      return { pending, manual, recent, active, cleared: pending + manual }
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
        const jobs = await claimAvailable()
        if (!jobs.length) break
        for (const job of jobs) {
          activeCount++
          void runJob(job)
        }
      }
    } finally { pumping = false }
  }

  return {
    file: filePath,
    enqueue,
    snapshot,
    cancel,
    clearQueue,
    updateNotice,
    update,
    finish,
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
