// .addpremium / .addprem — beri premium ke seseorang dengan durasi.
// .delpremium / .delprem — cabut premium seseorang.
// Satu plugin untuk kedua perintah (command /^(add|del)prem(ium)?$/i),
// supaya alur lengkapnya terbaca utuh di satu file (AGENTS.md §12):
// pemakaian -> target -> durasi -> tulis record -> balasan. Tidak ada
// helper khusus fitur ini; yang dipakai dari luar hanya helper premium
// universal (lib/helpers/premium.js — status/sisa/format) dan resolver
// identitas universal (lib/identity/resolver.js + conn.identity).
//
// Target (prioritas: argumen > reply > DM):
//   1. Token pemakai di argumen: mention/tag (@...), nomor polos,
//      JID, atau LID. Nomor polos SELALU dianggap target, bukan
//      durasi — jadi `.addprem 62812... 1w` benar, dan `.addprem 1w`
//      tanpa target lain jatuh ke bentuk 2/3. Mention diambil dari
//      mentionedJid (identitas aslinya), bukan dari teksnya.
//   2. Reply pesan seseorang -> m.quoted.sender.
//   3. Di DM (bukan grup) tanpa target lain -> lawan bicara (m.chat).
//   4. Kalau tidak ada satupun -> lempar string pemakaian.
//
// Durasi (addpremium saja): token `^(\d+)([dwm])$` (huruf besar/kecil
// sama) — d = 1 hari, w = 7 hari, m = 1 bulan = 30 hari. Semua token
// durasi DIJUMLAHKAN (multi-label: `1w 5d` = 12 hari, `1m 1w 1d` =
// 38 hari). Tanpa token durasi -> lempar string pemakaian (tidak ada
// durasi bawaan yang dikarang). Token yang bukan target dan bukan
// durasi (mis. `3x`, `0d`) -> lempar string yang jelas.
//
// Masa berlaku (addpremium): bila pemakai sudah premium permanen
// (premiumTime 0) -> balas info, tidak ada yang diubah. Bila premium
// masih aktif -> PERPANJANG dari masa berlaku yang lama (bukan dari
// sekarang). Bila habis/belum pernah -> hitung dari sekarang. Selalu
// tulis u.premium = true + u.premiumTime = masa berlaku baru, lalu
// db.save('users').
//
// Record users keyed by LID: target diuraikan lewat
// conn.identity.resolve ke { lid, jid }; kunci record = lid bila
// diketahui, jid bila belum (pemetaan dipelajari/digabung belakangan
// oleh identity.learn — pola yang sama seperti .banchat; lihat
// catatan di bawah soal pemetaan yang belum diketahui).
//
// Catatan: bila pemetaan JID<->LID target belum diketahui bot sama
// sekali saat perintah dijalankan, premium ditulis ke record kunci
// JID; record itu digabung ke kunci LID saat pemetaannya dipelajari
// (identity.learn). Praktisnya tidak kena untuk orang yang pernah
// berkirim pesan dengan bot, karena kedua bentuknya sudah diketahui.
import { normalize, kind, phoneDigits } from '#lib/identity/resolver.js'
import { isPremium, refreshPremium, formatPremiumRemaining } from '#lib/helpers/premium.js'
import { duration, formatTime } from '#lib/helpers/time.js'

const DAY_MS = 86400000
const UNITS = { d: 1, w: 7, m: 30 } // m = bulan, 30 hari (bukan menit)
const digitsOf = id => String(id ?? '').split('@')[0].split(':')[0].replace(/\D/g, '')

const USAGE_ADD = [
  'Cara pakai: .addpremium <target> <durasi>',
  'Target: reply pesan seseorang, tag @user, atau nomor (62812...)',
  'Durasi: 1d = 1 hari, 1w = 1 minggu, 1m = 1 bulan (30 hari). Bisa digabung, contoh: 1w 5d',
  'Contoh: .addprem @sailox 1w 5d',
].join('\n')
const USAGE_DEL = [
  'Cara pakai: .delpremium <target>',
  'Target: reply pesan seseorang, tag @user, atau nomor (62812...)',
  'Contoh: .delprem @sailox',
].join('\n')

// Uraikan satu target menjadi kunci record users (+ kedua bentuknya
// untuk label/seed). Menolak bot itu sendiri, seperti .banchat.
async function resolveUserTarget(conn, input, { participants }) {
  if (typeof input !== 'string' || !input) throw 'Target tidak dikenali.'
  const resolved = await conn.identity.resolve(input, { participants })
  if (!resolved || (!resolved.lid && !resolved.jid)) {
    throw 'Target tidak dikenali. Pakai nomor, JID, atau LID yang valid.'
  }
  const key = resolved.lid ?? resolved.jid
  if (conn.identity.isBot(key) || conn.identity.isBot(input)) {
    throw 'Target adalah bot itu sendiri.'
  }
  return { key, lid: resolved.lid ?? null, jid: resolved.jid ?? null }
}

// Token durasi -> ms, atau null bila bukan token durasi. Token yang
// bentuknya durasi tapi nilainya tidak sah (0, terlalu besar) dilempar
// dengan pesan yang jelas — bukan didiamkan.
function parseDurationToken(token) {
  const m = /^(\d+)([dwm])$/i.exec(token)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw `Durasi '${token}' tidak valid. Pakai angka lebih dari 0, contoh: 1d, 2w, 1m.`
  }
  return n * UNITS[m[2].toLowerCase()] * DAY_MS
}

// Apakah token ini token pemakai (bukan durasi)? Dipakai saat memindai
// argumen: nomor polos, JID, LID, atau mention.
function isUserToken(token) {
  if (token.startsWith('@')) return true
  const n = normalize(token)
  if (n && (kind(n) === 'pn' || kind(n) === 'lid')) return true
  return phoneDigits(token) != null
}

// Pindai argumen: kumpulkan target (paling banyak satu) dan total
// durasi (jumlah semua token durasi). Nomor telepon yang terbelah
// spasi (`+62 812-...`) digabung dulu sebelum dinilai.
function scanArgs(args, mentionedJid, usage) {
  let targetInput = null
  let mentionIdx = 0
  let totalMs = 0
  for (let i = 0; i < args.length; i++) {
    let token = args[i]
    // Nomor terbelah spasi: `+62` + `812-...` -> satu nomor.
    if (/^\+\d{1,3}$/.test(token) && i + 1 < args.length && /^[\d-]+$/.test(args[i + 1])) {
      token = token + args[i + 1]
      i++
    }
    const dur = parseDurationToken(token)
    if (dur != null) {
      totalMs += dur
      continue
    }
    if (!isUserToken(token)) throw `Token '${token}' tidak dikenali.\n${usage}`
    if (targetInput != null) throw 'Cukup satu target. Contoh: .addprem @sailox 1w 5d'
    if (token.startsWith('@')) {
      // Mention asli dari mentionedJid (sudah LID bila diketahui);
      // kalau tidak ada (diketik mentah), uraikan teksnya.
      targetInput = mentionedJid?.[mentionIdx++] ?? token
    } else {
      targetInput = token
    }
  }
  // totalMs 0 = tidak ada token durasi sama sekali (token durasi yang
  // tidak sah sudah dilempar di atas); jumlah yang meluap ditolak.
  if (totalMs !== 0 && !Number.isSafeInteger(totalMs)) throw 'Durasi terlalu besar.'
  return { targetInput, totalMs }
}

// Tentukan target (argumen > reply > DM) dan kembalikan record users-nya.
async function resolveTarget(m, ctx, args) {
  const { conn, participants } = ctx
  const usage = ctx.command.startsWith('del') ? USAGE_DEL : USAGE_ADD
  const { targetInput, totalMs } = scanArgs(args, m.mentionedJid, usage)
  let input = targetInput
  if (input == null && m.quoted?.sender) input = m.quoted.sender
  if (input == null && !m.isGroup) input = m.chat
  if (input == null) throw usage
  const target = await resolveUserTarget(conn, input, { participants })
  const u = global.db.ensure('users', target.key, { lid: target.lid ?? '', jid: target.jid ?? '' })
  const label = digitsOf(target.jid ?? target.key)
  return { target, user: u, label, totalMs }
}

let handler = async (m, ctx) => {
  const now = Date.now()
  const isDel = ctx.command.startsWith('del')
  const { user: u, label, totalMs } = await resolveTarget(m, ctx, ctx.args ?? [])

  if (isDel) {
    // .delpremium tidak memakai durasi; token durasi di sini hampir
    // pasti salah ketik — tolak dengan pemakaian, jangan didiamkan.
    if (totalMs) throw USAGE_DEL
    refreshPremium(u, now)
    if (!u.premium) {
      await m.reply(`ℹ️ ${label} tidak premium.`)
      return
    }
    u.premium = false
    u.premiumTime = 0
    await global.db.save('users')
    await m.reply(`✅ Premium ${label} dicabut.`)
    return
  }

  // addpremium: durasi wajib (tidak ada bawaan yang dikarang).
  if (!totalMs) throw USAGE_ADD
  refreshPremium(u, now)
  if (isPremium(u, now) && !u.premiumTime) {
    await m.reply(`ℹ️ ${label} sudah premium permanen — tidak ada yang diubah.`)
    return
  }
  // Masih aktif -> perpanjang dari masa berlaku lama; kalau tidak,
  // hitung dari sekarang.
  const base = u.premiumTime && u.premiumTime > now ? u.premiumTime : now
  u.premium = true
  u.premiumTime = base + totalMs
  await global.db.save('users')
  await m.reply([
    `✅ Premium ditambahkan untuk ${label}.`,
    `• Durasi: ${duration(totalMs)}`,
    `• Sisa premium: ${formatPremiumRemaining(u, now)}`,
    `• Berlaku sampai: ${formatTime(u.premiumTime)}`,
  ].join('\n'))
}
handler.help = ['addpremium <target> <durasi>', 'delpremium <target>']
handler.tags = ['owner']
handler.command = /^(add|del)prem(ium)?$/i
handler.owner = true
export default handler
