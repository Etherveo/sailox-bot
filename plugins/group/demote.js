import { parseTargets, resolveMentionTargets, findParticipant, isAdminParticipant, isCreatorParticipant } from '#lib/helpers/groupTargets.js'
// Turunkan admin grup jadi member biasa. Target dari tag, reply, atau
// nomor. Yang memang member biasa ditolak eksplisit — tidak ada demote
// ganda; pembuat grup tidak bisa diturunkan.
let handler = async (m, { conn, text, participants, groupMetadata, usedPrefix, command }) => {
  const parsedTargets = parseTargets({ mentionedJid: m.mentionedJid, quotedSender: m.quoted?.sender, text })
  if (!parsedTargets.length) throw `Siapa yang mau diturunkan jadi member biasa?\nContoh: ${usedPrefix + command} @tag — atau reply pesannya / ketik nomornya.`
  const targets = await resolveMentionTargets(conn, parsedTargets, { participants, groupMetadata })
  const lines = []
  for (const t of targets) {
    const p = findParticipant(participants, t)
    if (!p) { lines.push(`${t.mentionLabel} — bukan member grup ini, tidak bisa diturunkan.`); continue }
    if (isCreatorParticipant(p)) { lines.push(`${t.mentionLabel} — pembuat grup, tidak bisa diturunkan.`); continue }
    if (!isAdminParticipant(p)) { lines.push(`${t.mentionLabel} — memang member biasa (bukan admin), tidak di-demote dua kali.`); continue }
    const [res] = await conn.groupParticipantsUpdate(m.chat, [t.id], 'demote') ?? []
    const status = String(res?.status ?? '')
    lines.push(status === '200' ? `${t.mentionLabel} — sekarang member biasa ✅` : `${t.mentionLabel} — gagal diturunkan (status ${status || 'tidak diketahui'}).`)
  }
  await conn.reply(m.chat, lines.join('\n'), m, { mentions: targets.map(t => t.mentionId) })
}
handler.help = ['demote <@tag/reply/nomor>']; handler.tags = ['group']; handler.command = /^demote$/i
handler.group = true; handler.admin = true; handler.botAdmin = true
export default handler
