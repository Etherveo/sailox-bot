// Penanda follow-up interaktif .tt (balas hd/mp3) — padanan conn.tiktokopt
// legacy. Kunci = chat:sender (legacy hanya sender; chat ditambahkan supaya
// balasan 'hd' di grup lain tidak ikut terpicu). Kedaluwarsa MALAS (lazy):
// entri kedaluwarsa dianggap tidak ada saat dibaca — tanpa timer, tanpa
// timer bocor saat proses berjalan lama.
export const TIKTOK_FOLLOWUP_TTL_MS = 40 * 1000

export function createTiktokFollowupStore({ ttlMs = TIKTOK_FOLLOWUP_TTL_MS, now = () => Date.now() } = {}) {
  const map = new Map()
  const key = (chat, sender) => `${chat}:${sender}`
  return {
    put(chat, sender, value) { map.set(key(chat, sender), { ...value, expiresAt: now() + ttlMs }) },
    get(chat, sender) {
      const k = key(chat, sender)
      const e = map.get(k)
      if (!e) return null
      if (e.expiresAt <= now()) { map.delete(k); return null }
      return e
    },
    delete(chat, sender) { map.delete(key(chat, sender)) },
    get size() { return map.size },
  }
}

/** Singleton dipakai plugin .tt. */
export const tiktokFollowup = createTiktokFollowupStore()
