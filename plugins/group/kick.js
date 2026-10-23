import { parseTargets, findParticipant, isCreatorParticipant } from '#lib/helpers/groupTargets.js'
// Keluarkan peserta dari grup (adaptasi group-kick.js legacy). Target dari
// tag, reply, atau nomor. Yang sudah bukan member ditolak eksplisit —
// tidak ada kick ganda. Owner/founder, pembuat grup, dan bot sendiri
// dilindungi.
let handler = async (m, { conn, text, participants, usedPrefix, command }) => {
  const targets = parseTargets({ mentionedJid: m.mentionedJid, quotedSender: m.quoted?.sender, text })
  if (!targets.length) throw `Siapa yang mau dikeluarkan?\nContoh: ${usedPrefix + command} @tag — atau reply pesannya / ketik nomornya.`
  const lines = []
  for (const t of targets) {
    const p = findParticipant(participants, t)
    if (!p) { lines.push(`@${t.digits} — bukan member grup ini (sudah keluar?), tidak di-kick dua kali.`); continue }
    if (conn.identity.isBot(t.id) || conn.identity.isBot(p.id)) { lines.push(`@${t.digits} — itu botnya sendiri, tidak bisa dikeluarkan. 😅`); continue }
    if (conn.identity.roleOf(t.id).isOwner || conn.identity.roleOf(p.id).isOwner) { lines.push(`@${t.digits} — owner/founder bot, tidak bisa dikeluarkan.`); continue }
    if (isCreatorParticipant(p)) { lines.push(`@${t.digits} — pembuat grup, tidak bisa dikeluarkan.`); continue }
    const [res] = await conn.groupParticipantsUpdate(m.chat, [t.id], 'remove') ?? []
    const status = String(res?.status ?? '')
    lines.push(status === '200' ? `@${t.digits} — berhasil dikeluarkan ✅` : `@${t.digits} — gagal dikeluarkan (status ${status || 'tidak diketahui'}).`)
  }
  await conn.reply(m.chat, lines.join('\n'), m, { mentions: targets.map(t => t.id) })
}
handler.help = ['kick <@tag/reply/nomor>']; handler.tags = ['group']; handler.command = /^ki(c)?k$/i
handler.group = true; handler.admin = true; handler.botAdmin = true
export default handler
