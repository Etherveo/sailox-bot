import { parseTargets, resolveMentionTargets, findParticipant, isAdminParticipant } from '#lib/helpers/groupTargets.js'
// Jadikan peserta sebagai admin grup (adaptasi group-promote.js legacy).
// Target dari tag, reply, atau nomor. Yang sudah admin ditolak eksplisit —
// tidak ada promote ganda; yang bukan member juga ditolak.
let handler = async (m, { conn, text, participants, groupMetadata, usedPrefix, command }) => {
  const parsedTargets = parseTargets({ mentionedJid: m.mentionedJid, quotedSender: m.quoted?.sender, text })
  if (!parsedTargets.length) throw `Siapa yang mau dijadikan admin?\nContoh: ${usedPrefix + command} @tag — atau reply pesannya / ketik nomornya.`
  const targets = await resolveMentionTargets(conn, parsedTargets, { participants, groupMetadata })
  const lines = []
  for (const t of targets) {
    const p = findParticipant(participants, t)
    if (!p) { lines.push(`${t.mentionLabel} — bukan member grup ini, tidak bisa dijadikan admin.`); continue }
    if (isAdminParticipant(p)) { lines.push(`${t.mentionLabel} — sudah admin, tidak di-promote dua kali.`); continue }
    const [res] = await conn.groupParticipantsUpdate(m.chat, [t.id], 'promote') ?? []
    const status = String(res?.status ?? '')
    lines.push(status === '200' ? `${t.mentionLabel} — sekarang jadi admin ✅` : `${t.mentionLabel} — gagal dijadikan admin (status ${status || 'tidak diketahui'}).`)
  }
  await conn.reply(m.chat, lines.join('\n'), m, { mentions: targets.map(t => t.mentionId) })
}
handler.help = ['promote <@tag/reply/nomor>']; handler.tags = ['group']; handler.command = /^promote$/i
handler.group = true; handler.admin = true; handler.botAdmin = true
export default handler
