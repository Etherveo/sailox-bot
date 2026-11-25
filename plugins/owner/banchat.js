// .banchat / .unbanchat — blokir/buka chat (grup atau DM seseorang).
// Satu plugin untuk kedua perintah (command /^(ban|unban)chat$/i),
// supaya alur lengkapnya terbaca utuh di satu file (AGENTS.md §12):
// pemakaian -> target -> tulis flag -> balasan. Tidak ada helper
// khusus fitur ini; yang dipakai dari luar hanya resolver identitas
// universal (normalize/kind + conn.identity) — lihat
// lib/identity/resolver.js.
//
// Tiga bentuk pemakaian (prioritas: argumen > reply > chat saat ini):
//   1. `.banchat` / `.unbanchat` polos -> chat saat ini (grup itu
//      sendiri, atau DM lawan bicara).
//   2. `.banchat` sambil reply pesan seseorang -> DM orang itu
//      (m.quoted.sender). Dipakai untuk membuka DM seseorang dari
//      dalam grup.
//   3. `.banchat <nomor | jid | lid>` -> DM orang itu. Nomor polos
//      jadi JID nomor telepon; JID/LID utuh dipakai apa adanya.
//      Mention ('@...') juga bisa — JID aslinya diambil dari
//      mentionedJid, bukan dari teksnya.
//
// JID vs LID — kenapa flag ditulis ke SEMUA bentuk:
// Satu orang punya dua identitas (JID nomor telepon dan LID). Pesan
// dari orang yang sama bisa tiba sebagai JID atau sebagai LID,
// tergantung apa yang diketahui bot saat itu. Kalau flag cuma ditulis
// di satu bentuk, ban/unban bisa ditembus lewat bentuk satunya.
// Karena itu setiap target diuraikan ke semua bentuknya yang diketahui
// (JID + LID) dan flag ditulis ke record chats untuk tiap bentuk,
// ditambah semua record chats yang sudah ada dan merujuk orang yang
// sama (conn.identity.same). Pemeriksaan di pipeline
// (lib/plugins/pipeline.js) membaca record chats[m.chat] — karena
// semua bentuk sudah sama nilainya, hasil pemeriksaannya sama lewat
// bentuk mana pun pesan itu tiba.
//
// Beda dengan .banuser/.unbanuser (lib/helpers/moderation.js): di sana
// target WAJIB terpetakan ke LID karena record users keyed by LID.
// Di sini tidak: record chats ada per bentuk (JID dan LID), jadi
// target yang cuma diketahui satu bentuknya tetap bisa ditandai.
//
// Catatan: pemetaan JID<->LID yang belum diketahui bot saat perintah
// dijalankan tidak bisa ditandai; record bentuk itu akan dibuat dengan
// nilai bawaan (isBanned: true) saat pesan pertamanya tiba, lalu
// pemetaan dipelajari dan record lama digabung (lihat identity.learn).
// Praktisnya, untuk orang yang pernah berkirim pesan dengan bot,
// kedua bentuk sudah diketahui.
import { normalize, kind } from '#lib/identity/resolver.js'

const digitsOf = id => String(id ?? '').split('@')[0].split(':')[0].replace(/\D/g, '')

// Kumpulkan semua kunci record chats untuk satu orang: bentuk JID dan
// LID yang diketahui, plus semua record yang sudah ada dan merujuk
// orang yang sama. Tanpa ini, ban/unban lewat satu bentuk bisa
// ditembus lewat bentuk lainnya.
async function userTarget(conn, primary, resolved = {}) {
  if (conn.identity.isBot(primary)) throw 'Target adalah bot itu sendiri.'
  const forms = new Set()
  const add = id => { const n = normalize(id); if (n && (kind(n) === 'pn' || kind(n) === 'lid')) forms.add(n) }
  add(primary); add(resolved.lid); add(resolved.jid)
  // Lengkapi bentuk lawannya lewat pemetaan (cache + Signal store).
  for (const f of [...forms]) {
    try { add(await conn.identity.toLid(f)) } catch {}
    try { add(await conn.identity.toJid(f)) } catch {}
  }
  const keys = new Set(forms)
  // Record chats yang sudah ada dan merujuk orang yang sama (misalnya
  // dibuat sebelum pemetaannya diketahui) ikut ditandai.
  for (const key of Object.keys(global.db.data.chats)) {
    if ([...forms].some(f => conn.identity.same(key, f))) keys.add(normalize(key))
  }
  if (!keys.size) throw 'Target tidak dikenali.'
  const pn = [...keys].find(k => kind(k) === 'pn')
  return { keys: [...keys], label: digitsOf(pn ?? [...keys][0]) }
}

// Tentukan chat mana yang diblokir/dibuka, dari tiga bentuk pemakaian.
// Mengembalikan { keys, label } — keys = semua kunci record chats yang
// harus ditandai; label = teks untuk balasan.
async function resolveChatTarget(m, ctx) {
  const { conn, text, participants, groupMetadata } = ctx
  const argText = String(text ?? '').trim()

  // 3) Argumen: nomor / JID / LID (atau mention).
  if (argText) {
    // Mention yang diketik ('@...'): identitas aslinya sudah ada di
    // mentionedJid (LID bila diketahui) — pakai itu, bukan teksnya.
    const mentioned = argText.startsWith('@') ? m.mentionedJid?.[0] : null
    const input = mentioned ?? argText
    // JID grup langsung jadi target grup.
    const asJid = normalize(input)
    if (asJid && kind(asJid) === 'group') {
      return { keys: [asJid], label: `grup ${digitsOf(asJid)}` }
    }
    const resolved = await conn.identity.resolve(input, { participants })
    if (!resolved || (!resolved.lid && !resolved.jid)) {
      throw 'Target tidak dikenali. Pakai nomor, JID, atau LID yang valid.'
    }
    return userTarget(conn, resolved.lid ?? resolved.jid, resolved)
  }

  // 2) Reply: pengirim pesan yang di-reply (DM orang itu).
  if (m.quoted?.sender) {
    return userTarget(conn, m.quoted.sender, { lid: m.quoted.sender, jid: m.quoted.senderJid ?? null })
  }

  // 1) Chat saat ini: grup itu sendiri, atau DM lawan bicara.
  if (m.isGroup) {
    return { keys: [normalize(m.chat)], label: `grup ${groupMetadata?.subject ?? 'ini'}` }
  }
  return userTarget(conn, m.chat)
}

let handler = async (m, ctx) => {
  const banned = ctx.command === 'banchat'
  const target = await resolveChatTarget(m, ctx)
  for (const key of target.keys) global.db.ensure('chats', key).isBanned = banned
  await global.db.save('chats')
  await m.reply(`Chat ${target.label} ${banned ? 'diblokir' : 'dibuka'}.`)
}
handler.help = ['banchat [target]', 'unbanchat [target]']
handler.tags = ['owner']
handler.command = /^(ban|unban)chat$/i
handler.owner = true
export default handler
