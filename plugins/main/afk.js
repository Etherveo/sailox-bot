// plugins/main/afk.js
//
// Porting fitur AFK legacy (perintah Veo 2026-11-11):
// - plugins/main-afk_.js -> .afk [alasan]
// - plugins/main-brb.js  -> alias brb/off tanpa prefix
// - plugins/main-afk.js  -> hook before: pengumuman saat pengirim pulang
//   dari AFK + pemberitahuan saat seseorang me-mention/me-reply orang AFK.
// Status tinggal di record user (afk/afkReason, sudah ada di users v3),
// jadi tidak ada collection, helper, atau file baru: seluruh logic fitur
// ini tinggal di file ini (AGENTS.md §12).
//
// Perilaku yang dipertahankan dari legacy:
// - .afk tanpa alasan -> "Tanpa Keterangan"; brb/off tanpa alasan ->
//   "Gktau, kabur aja"; pengumuman pulang tanpa alasan tersimpan ->
//   "Gatau, kabur aja".
// - Durasi tampil "Xj Ym Zd" seperti legacy (jam terus bertambah).
//
// Satu penyimpangan kecil yang disengaja: pesan perintah .afk/.brb/.off
// dari pengirim yang sedang AFK TIDAK memicu pengumuman pulang dulu —
// command-nya langsung mengeset ulang AFK. Legacy mengumumkan pulang
// lalu mengeset AFK lagi (dua pesan berurutan).
import { jidDecode } from '@whiskeysockets/baileys'

const MAX_REASON = 200
const BARE_TRIGGER = /^(brb|off)(?:\s+([\s\S]*))?$/i
const AFK_COMMAND_WORD = /^(afk|brb|off)(\s|$)/i

export function formatAfkDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return `${hours}j ${minutes}m ${seconds}d`
}

function cleanReason(text, fallback) {
  const reason = String(text ?? '').trim().slice(0, MAX_REASON)
  return reason || fallback
}

function isAfkCommandText(text, prefixChars) {
  const t = String(text ?? '').trim()
  if (!t) return false
  const body = String(prefixChars ?? '').includes(t[0]) ? t.slice(1) : t
  return AFK_COMMAND_WORD.test(body)
}

// Bentuk mention final untuk teks balasan: label @ diambil dari JID hasil
// forAction (bentuk aktif grup), bukan digit mentah — kalau forAction
// tidak tersedia, pakai JID apa adanya.
async function mentionTarget(ctx, jid) {
  let form = jid
  try {
    const out = await ctx?.conn?.identity?.forAction?.([jid], 'mention', { groupMetadata: ctx?.groupMetadata })
    if (Array.isArray(out) && out[0]) form = out[0]
  } catch {}
  let user = String(form).split('@')[0]
  try { user = jidDecode(form).user } catch {}
  return { label: '@' + user, jid: form }
}

async function saveUsers() {
  if (global.db?.save) await global.db.save('users')
}

function clockString(ts) {
  return new Date(ts).toLocaleString('id-ID', { timeZone: global.timezone ?? 'Asia/Jakarta' })
}

async function setAfk(m, ctx, u, reason, fallback) {
  u.afk = Date.now()
  u.afkReason = cleanReason(reason, fallback)
  await saveUsers()
  const me = await mentionTarget(ctx, m.sender)
  return m.reply(
    `👤 User: ${me.label}\n📊 Status: _Afk_\n📑 Alasan: _${u.afkReason}_\n⏰ Waktu AFK: _${clockString(u.afk)}_`,
    undefined, { mentions: [me.jid] })
}

let handler = async (m, ctx) => {
  const { text, command, userData: u } = ctx
  return setAfk(m, ctx, u, text, command === 'afk' ? 'Tanpa Keterangan' : 'Gktau, kabur aja')
}

// Pengamat AFK: berjalan untuk semua pesan (seperti legacy) — bukan hanya
// command. Pesan bot sendiri dilewati supaya balasan bot tidak menghapus
// status AFK atau memicu pemberitahuan.
handler.before = async (m, ctx) => {
  if (m.fromMe) return false
  const users = global.db?.data?.users ?? {}
  const u = ctx?.userData ?? users[m.sender]
  const text = (m.text ?? '').trim()

  // Alias tanpa prefix "brb"/"off" (legacy main-brb.js): "brb" saja atau
  // "brb <alasan>". Ditangani di sini supaya tetap satu file fitur.
  const bare = BARE_TRIGGER.exec(text)
  if (bare) {
    if (!u) return false
    await setAfk(m, ctx, u, bare[2], 'Gktau, kabur aja')
    return true
  }

  // Pengirim pulang dari AFK: umumkan + durasi, lalu hapus status.
  // (Pengecekan mention di bawah tetap jalan walau pengirim tidak AFK.)
  let me = null
  if (u && Number.isFinite(u.afk) && u.afk > -1) {
    // Perintah .afk/.brb/.off saat sudah AFK: biarkan command yang
    // mengeset ulang, jangan umumkan pulang dulu (lihat catatan di atas).
    const prefixChars = String(ctx?.settings?.prefix ?? globalThis.prefix ?? '.!/#$')
    if (isAfkCommandText(text, prefixChars)) return false

    me = await mentionTarget(ctx, m.sender)
    await m.reply(
      `👤 Yo ${me.label}!\n📊 Status: _Udah balik dari AFK_\n📑 Alasan: _${u.afkReason || 'Gatau, kabur aja'}_\n⏰ Durasi: _${formatAfkDuration(Date.now() - u.afk)}_`,
      undefined, { mentions: [me.jid] })
    u.afk = -1
    u.afkReason = ''
    await saveUsers()
  }

  // Beri tahu pengirim bila ia me-mention/me-reply orang yang sedang AFK.
  const jids = [...new Set([...(m.mentionedJid || []), ...(m.quoted ? [m.quoted.sender] : [])])]
  for (const jid of jids) {
    if (!jid || jid === m.sender) continue
    const target = users[jid]
    if (!target || !Number.isFinite(target.afk) || target.afk < 0) continue
    me ??= await mentionTarget(ctx, m.sender)
    const them = await mentionTarget(ctx, jid)
    await m.reply(
      `Oi ${me.label}, jangan ganggu!\n${them.label} lagi AFK${target.afkReason ? ` karena "${target.afkReason}"` : ' tanpa alasan, misterius banget'}\nUdah ${formatAfkDuration(Date.now() - target.afk)}`,
      undefined, { mentions: [me.jid, them.jid] })
  }
  return false
}

handler.help = ['afk [alasan]', 'brb [alasan]', 'off [alasan]']
handler.tags = ['main']
handler.command = /^(afk|brb|off)$/i

export default handler
