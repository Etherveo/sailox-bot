// lib/helpers/pickSession.js
//
// Sesi pilih interaktif untuk hasil list downloader (saat ini dipakai
// folder GoFile via .dl; Pixeldrain masih pola #item lama, .tt masih
// memakai store-nya sendiri). Generalisasi dari tiktokFollowup.js:
// kunci chat:sender supaya pick di satu chat tidak terpicu dari chat
// lain, kedaluwarsa MALAS (dianggap tidak ada saat dibaca, tanpa timer),
// dan TTL diperpanjang (touch) setiap pick berhasil — sesi tetap buka
// selama user masih memilih, bukan sekali pakai.
//
// Isi sesi: { provider, baseUrl, title, items: [{ fileName, size }],
// lastBatch } — lastBatch ditulis prosesor batch saat batch selesai
// ({ failed: [index], kept: [{ index, fileName, relPath, size }] })
// supaya perintah `lanjut` bisa mengulang item yang gagal.
//
// Sesi hidup di RAM (seperti .tt): restart bot menghilangkannya, tapi
// progres batch yang sedang berjalan tetap tersimpan di antrean JSON
// (lib/downloader/queue.js) dan dilanjutkan otomatis oleh pump.

export const PICK_SESSION_TTL_MS = 15 * 60 * 1000

export function createPickSessionStore({ ttlMs = PICK_SESSION_TTL_MS, now = () => Date.now() } = {}) {
  const map = new Map()
  const key = (chat, sender) => `${chat}:${sender}`
  function prune() {
    for (const [k, e] of map) if (e.expiresAt <= now()) map.delete(k)
  }
  return {
    put(chat, sender, value) {
      if (map.size >= 500) prune()
      map.set(key(chat, sender), { ...value, expiresAt: now() + ttlMs })
    },
    get(chat, sender) {
      const k = key(chat, sender)
      const e = map.get(k)
      if (!e) return null
      if (e.expiresAt <= now()) { map.delete(k); return null }
      return e
    },
    // Perpanjang TTL tanpa mengubah isi (dipanggil tiap pick berhasil).
    touch(chat, sender) {
      const e = map.get(key(chat, sender))
      if (e && e.expiresAt > now()) e.expiresAt = now() + ttlMs
    },
    delete(chat, sender) { map.delete(key(chat, sender)) },
    get size() { return map.size },
  }
}

/** Singleton dipakai runJob (pembuka sesi) dan plugin pick (hook pilih). */
export const pickSessions = createPickSessionStore()
