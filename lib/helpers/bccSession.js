// lib/helpers/bccSession.js
//
// Sesi tanya-jawab .bcc (broadcast ke saluran) + logika komposisi murni.
//
// Alur konflik: .bcc yang membawa teks direct DAN teks reply (caption
// gambar yang di-reply, atau teks pesan yang di-reply) tidak langsung
// disiarkan — bot bertanya dulu lewat handler.before, dan pengguna
// menjawab angka biasa (tanpa reply):
//   1 = teks direct, 2 = teks reply, 3 = gabung
// Kalau pilih gabung, bot bertanya lagi urutannya:
//   1 = direct di atas, reply di bawah; 2 = sebaliknya.
// 'batal' menutup sesi. Sesi hidup di RAM (seperti pickSession): restart
// bot menghilangkannya, dan media yang ditahan ikut hilang — pengguna
// tinggal mengulang perintahnya.
//
// Media yang dibawa sesi HANYA gambar (imageMessage). Caption/teks dari
// pesan lain (mis. video) tetap dihitung sebagai teks reply, tapi
// medianya tidak ikut disiarkan — itu batas yang disengaja, bukan bug.

export const BCC_SESSION_TTL_MS = 5 * 60 * 1000
export const BCC_CAPTION_LIMIT = 1024

export function createBccSessionStore({ ttlMs = BCC_SESSION_TTL_MS, now = () => Date.now() } = {}) {
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
    touch(chat, sender) {
      const e = map.get(key(chat, sender))
      if (e && e.expiresAt > now()) e.expiresAt = now() + ttlMs
    },
    delete(chat, sender) { map.delete(key(chat, sender)) },
    get size() { return map.size },
  }
}

/** Singleton dipakai plugin bcc (pembuka sesi) dan hook pilihnya. */
export const bccSessions = createBccSessionStore()

// Keputusan isi siaran dari dua sumber teks. 'conflict' hanya bila
// keduanya non-kosong — satu sumber saja langsung dipakai, tanpa tanya.
export function decideBcc({ directText = '', replyText = '' } = {}) {
  const d = String(directText ?? '').trim()
  const r = String(replyText ?? '').trim()
  if (d && r) return { kind: 'conflict', directText: d, replyText: r }
  if (d) return { kind: 'direct', text: d }
  if (r) return { kind: 'reply', text: r }
  return { kind: 'empty', text: '' }
}

// Gabung dua teks untuk caption/pesan: satu baris kosong tidak pernah
// disisipkan ganda — sumber kosong dilewati, sisanya dipisah '\n'.
export function combineBccTexts(directText, replyText, order) {
  const d = String(directText ?? '').trim()
  const r = String(replyText ?? '').trim()
  const parts = order === 'reply-first' ? [r, d] : [d, r]
  return parts.filter(Boolean).join('\n')
}

// Cuplikan satu baris untuk prompt pilihan (teks asli tidak dipotong
// saat disiarkan — ini hanya tampilan).
export function previewBcc(text, max = 200) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

const NEWSLETTER_JID_RE = /^\d+@newsletter$/

// Tujuan siaran: dibaca segar dari config setiap kali dipakai (bukan
// disimpan di sesi), supaya perubahan .config set botChannel langsung
// berlaku termasuk untuk sesi yang sedang buka. null = belum diatur
// atau formatnya bukan JID saluran.
export function resolveBccTarget(value = globalThis.botChannel) {
  const v = String(value ?? '').trim()
  return NEWSLETTER_JID_RE.test(v) ? v : null
}
