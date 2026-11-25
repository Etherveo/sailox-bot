// plugins/info/profile.js
//
// .profile / .profil — profil pemakai, SATU FILE UTUH tanpa helper (spek
// founder 2026-11-25): semua logika ada di file ini saja — nama dari DB,
// umur, level/EXP, limit, status premium + durasi premium — supaya gampang
// diubah langsung tanpa menyelam ke lib/.
//
// Target (tambahan 2026-11-25, permintaan Veo):
//   .profile           -> profil pengirim sendiri
//   .profile @user     -> profil orang yang di-tag
//   .profile (reply)   -> profil pengirim pesan yang di-reply
//   .profile 62812...  -> profil pemilik nomor itu
// Prioritas: tag > reply > nomor ketikan > pengirim sendiri. Profil
// target dibaca dari record users yang SUDAH ada — tidak membuat record
// baru untuk orang yang belum pernah memakai bot (bila tidak ada
// recordnya, balas 'tidak ditemukan').
//
// Field yang ditampilkan, sesuai spek:
//   Nama           — u.name dari database (BUKAN pushName / getName
//                    manual; user tanpa nama di DB -> 'Unknown')
//   Umur           — u.age dari .register (age -1 = belum diisi)
//   Level / EXP    — u.level / u.exp (dua baris terpisah)
//   Limit          — sisa/hari; premium aktif = Unlimited
//   Status premium — Aktif / Tidak aktif (premiumTime yang sudah lewat
//                    dianggap habis, walau flag premium masih true)
//   Durasi premium — HANYA bila premium aktif; 'Permanen' bila
//                    premiumTime 0, selain itu sisa sampai detik.
//
// Bebas limit (keputusan Veo 2026-11-25): sekali lihat profil tidak
// memotong limit.

// Durasi ms -> Bahasa Indonesia sampai detik, mis.
// "3 hari 4 jam 12 menit 30 detik" / "12 menit 30 detik" / "30 detik".
function formatDuration(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000))
  return [[Math.floor(s / 86400), 'hari'], [Math.floor(s / 3600) % 24, 'jam'], [Math.floor(s / 60) % 60, 'menit'], [s % 60, 'detik']]
    .filter(([n]) => n).map(([n, unit]) => `${n} ${unit}`).join(' ') || '0 detik'
}

// Premium aktif? premiumTime 0 = permanen; terisi tapi sudah lewat =
// tidak premium lagi (pengecekan kedaluwarsa di sini, bukan cuma di
// pipeline — supaya pemanggil yang tidak sempat refresh tetap benar).
function premiumActive(u, now = Date.now()) {
  if (!u?.premium) return false
  if (!u.premiumTime) return true
  return u.premiumTime > now
}

// Digit nomor dari teks ketikan: '62812...', '+62 812-...', '0812...'
// -> '62812...'; bukan nomor -> null.
function phoneDigitsOf(text) {
  if (typeof text !== 'string') return null
  const digits = text.replace(/\D/g, '')
  if (!digits) return null
  const d = digits.startsWith('0') ? '62' + digits.slice(1) : digits
  return /^\d{7,15}$/.test(d) ? d : null
}

// Cari record users untuk satu kunci identitas (LID/PN). Bila tidak ada
// di kunci itu, coba bentuk lawannya (LID <-> PN) lewat conn.identity.
// Read-only: tidak pernah membuat record baru.
async function findTargetUser(conn, key, ctx) {
  const users = global.db?.data?.users
  if (!users || !key) return null
  if (users[key]) return users[key]
  if (!conn?.identity) return null
  for (const fn of ['toJid', 'toLid']) {
    try {
      const alt = await conn.identity[fn]?.(key, ctx)
      if (alt && alt !== key && users[alt]) return users[alt]
    } catch { /* Bentuk lawan tidak dikenal — lanjut ke fallback. */ }
  }
  return null
}

let handler = async (m, { conn, userData: u, text, participants }) => {
  let target = null
  // Tag > reply > nomor ketikan > pengirim sendiri.
  const raw = m.mentionedJid?.[0] ?? m.quoted?.sender ?? (String(text ?? '').trim() || null)
  if (raw) {
    let key = null
    if (/^[^@\s]+@[^@\s]+$/.test(String(raw))) {
      // Sudah JID (tag / reply — identity.prime menormalkannya ke LID).
      key = String(raw)
    } else {
      // Ketikan: nomor, JID/LID mentah, atau @angka — uraikan lewat
      // conn.identity bila ada, kalau tidak ada pakai digit nomornya.
      let resolved = null
      try { resolved = await conn?.identity?.resolve?.(String(raw), { m, participants }) } catch { resolved = null }
      key = resolved?.lid ?? resolved?.jid ?? null
      if (!key) {
        const digits = phoneDigitsOf(String(raw))
        key = digits ? `${digits}@s.whatsapp.net` : null
      }
      if (!key) throw 'Target tidak dikenali. Tag orangnya, reply pesannya, atau ketik nomornya.'
    }
    if (conn?.identity?.isBot?.(key)) throw 'Itu bot, bukan orang — tidak ada profilnya.'
    target = await findTargetUser(conn, key, { m, participants })
    if (!target) throw 'Profil tidak ditemukan — orang itu belum pernah memakai bot.'
  }
  const tu = target ?? u
  const now = Date.now()
  const name = String(tu?.name ?? '').trim() || 'Unknown'
  const age = Number(tu?.age)
  const ageLine = Number.isFinite(age) && age > 0 ? `${age} tahun` : 'Belum diisi'
  const prem = premiumActive(tu, now)
  const daily = Math.max(0, Math.floor(Number(globalThis.defaultLimit ?? 50)))
  const limitLine = prem ? 'Unlimited (premium)' : `${Math.max(0, Number(tu?.limit) || 0)}/${daily}`
  const lines = [
    `👤 *Profil ${name}*`,
    `• Nama: ${name}`,
    `• Umur: ${ageLine}`,
    `• Level: ${tu?.level ?? 0}`,
    `• EXP: ${tu?.exp ?? 0}`,
    `• Limit: ${limitLine}`,
    `• Status Premium: ${prem ? 'Aktif' : 'Tidak aktif'}`,
  ]
  if (prem) lines.push(`• Durasi Premium: ${!tu.premiumTime ? 'Permanen' : formatDuration(tu.premiumTime - now)}`)
  return m.reply(lines.join('\n'))
}
handler.help = ['profile [@tag/reply/nomor]', 'profil [@tag/reply/nomor]']; handler.tags = ['info']; handler.command = /^(profile|profil)$/i
export default handler
