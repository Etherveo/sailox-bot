// lib/downloader/guardian.js
//
// Penjaga engine downloader (permintaan pemilik): setiap engine yang ERROR
// — gagal memuat (fase load, dari registry), gagal mengambil info, atau
// gagal mengunduh — dilaporkan LANGSUNG ke nomor owner/founder lewat
// WhatsApp, supaya kerusakan platform (API berubah, layanan mati) ketahuan
// dari laporan, bukan dari keluhan pengguna.
//
// Anti-spam untuk owner sendiri: laporan didedupe per (engine, fase)
// dengan cooldown (default 30 menit) — error yang sama berulang hanya
// menambah penghitung "tertahan" yang diselipkan ke laporan berikutnya.
// Laporan yang datang sebelum ada koneksi WA (mis. error load saat boot)
// ditahan sebagai pending dan diteruskan begitu permukaan downloader
// pertama memasang notifier (attachEngineNotifierWithConn dipanggil
// .download & .unduh setiap menerima perintah).

export const GUARDIAN_DEFAULTS = { cooldownMs: 30 * 60 * 1000, maxPending: 10 }

export function ownerJid() {
  const entry = globalThis.founder?.[0] ?? globalThis.owner?.[0]
  const num = Array.isArray(entry) ? entry[0] : entry
  const digits = String(num ?? '').replace(/\D/g, '')
  return digits ? `${digits}@s.whatsapp.net` : null
}

export function createEngineGuardian({ notify = null, now = () => Date.now(), ...limits } = {}) {
  const cfg = { ...GUARDIAN_DEFAULTS, ...limits }
  const lastSent = new Map()   // "engine|fase" -> timestamp laporan terakhir
  const suppressed = new Map() // "engine|fase" -> jumlah laporan tertahan
  const pending = []           // teks laporan menunggu notifier terpasang
  let notifyFn = notify

  function formatText({ engineId, phase, error, url, heldCount }) {
    const when = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'medium', timeZone: globalThis.timezone ?? 'Asia/Jakarta' }).format(new Date(now()))
    return [
      '🚨 *Engine downloader error*',
      `⚙️ Engine: ${engineId}`,
      `🧭 Fase: ${phase}`,
      `❌ ${String(error?.message ?? error).slice(0, 400)}`,
      url ? `🔗 URL pemicu: ${url}` : null,
      `🕐 ${when}`,
      heldCount ? `🔁 ${heldCount} error serupa tertahan sejak laporan terakhir (cooldown anti-spam).` : null,
      '',
      'Kelola lewat .listengine — aturan: docs/engine-plugin-downloader.md',
    ].filter(Boolean).join('\n')
  }

  async function deliver(text) {
    if (!notifyFn) {
      if (pending.length < cfg.maxPending) pending.push(text)
      return false
    }
    await notifyFn(text)
    return true
  }

  const api = {
    setNotifier(fn) {
      notifyFn = fn
      if (notifyFn && pending.length) {
        const backlog = pending.splice(0, pending.length)
        void (async () => { for (const text of backlog) await notifyFn(text).catch(() => {}) })()
      }
    },
    hasNotifier: () => Boolean(notifyFn),

    /** Laporkan error engine. Tidak pernah melempar — penjaga tidak boleh mematikan unduhan. */
    async report({ engineId, phase = 'runtime', error, url } = {}) {
      try {
        const key = `${engineId}|${phase}`
        const t = now()
        const last = lastSent.get(key)
        if (last !== undefined && t - last < cfg.cooldownMs) {
          suppressed.set(key, (suppressed.get(key) ?? 0) + 1)
          return { sent: false, suppressed: suppressed.get(key) }
        }
        const heldCount = suppressed.get(key) ?? 0
        suppressed.delete(key)
        lastSent.set(key, t)
        const sent = await deliver(formatText({ engineId, phase, error, url, heldCount }))
        return { sent, queued: !sent }
      } catch { return { sent: false } }
    },

    stats() {
      return { trackedKeys: lastSent.size, pending: pending.length, suppressedTotal: [...suppressed.values()].reduce((a, b) => a + b, 0) }
    },
  }
  return api
}

// ─── Singleton untuk bot utama ──────────────────────────────────────────────

export const engineGuardian = createEngineGuardian()

/** Pasang notifier berbasis conn WhatsApp: kirim laporan ke nomor founder/owner. */
export function attachEngineNotifierWithConn(conn) {
  if (!conn) return
  engineGuardian.setNotifier(async text => {
    const jid = ownerJid()
    if (!jid) return
    await conn.sendMessage(jid, { text })
  })
}

export function reportEngineError(report) {
  return engineGuardian.report(report)
}
