// lib/helpers/sessionStore.js
//
// Store sesi interaktif generik per chat+sender — generalisasi dari
// tiktokFollowup.js dan pickSession.js: Map + TTL, dengan callback
// kedaluwarsa OPSIONAL yang dijalankan saat sesi berakhir. Dipakai sesi
// yang harus BEREAKSI pada timeout (mis. menghapus pesan tawaran, atau
// antrekan pilihan default), bukan sekadar dianggap hilang.
//
// Timer: satu setTimeout per sesi, di-unref supaya tidak menahan proses,
// dan dibersihkan saat entri dipakai/dihapus — tanpa timer bocor.
// Tanpa callback, store ini berperilaku persis seperti pendahulunya:
// kedaluwarsa MALAS (dianggap tidak ada saat dibaca).
//
// Sesi hidup di RAM: restart bot menghilangkannya (tawaran yang belum
// terjawab tidak dihapus otomatis setelah restart — batasan yang
// diterima, sama seperti store sesi lain di bot ini).

export function createSessionStore({ ttlMs, now = () => Date.now(), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('createSessionStore butuh ttlMs positif.')
  const map = new Map()
  const key = (chat, sender) => `${chat}:${sender}`
  function fireExpired(entry) {
    const onExpire = entry?.onExpire
    if (typeof onExpire !== 'function') return
    try {
      const r = onExpire(entry)
      if (r && typeof r.catch === 'function') r.catch(() => {})
    } catch { /* callback kedaluwarsa tidak boleh melempar */ }
  }
  function clearTimer(entry) {
    if (entry?.timer) { try { clearTimeoutFn(entry.timer) } catch { /* abaikan */ } }
  }
  return {
    put(chat, sender, value, onExpire) {
      const k = key(chat, sender)
      clearTimer(map.get(k))
      if (map.size >= 500) {
        for (const [kk, e] of map) if (e.expiresAt <= now()) { clearTimer(e); map.delete(kk) }
      }
      const entry = { ...value, expiresAt: now() + ttlMs, onExpire: typeof onExpire === 'function' ? onExpire : null }
      if (entry.onExpire) {
        entry.timer = setTimeoutFn(() => {
          map.delete(k)
          fireExpired(entry)
        }, ttlMs)
        entry.timer?.unref?.()
      }
      map.set(k, entry)
      return entry
    },
    get(chat, sender) {
      const k = key(chat, sender)
      const e = map.get(k)
      if (!e) return null
      if (e.expiresAt <= now()) {
        clearTimer(e)
        map.delete(k)
        fireExpired(e)
        return null
      }
      return e
    },
    delete(chat, sender) {
      const k = key(chat, sender)
      clearTimer(map.get(k))
      map.delete(k)
    },
    get size() { return map.size },
  }
}
