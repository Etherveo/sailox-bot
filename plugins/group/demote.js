import { parseTargets, findParticipant, isAdminParticipant, isCreatorParticipant } from '#lib/helpers/groupTargets.js'
// Turunkan admin grup jadi member biasa. Target dari tag, reply, atau
// nomor. Yang memang member biasa ditolak eksplisit — tidak ada demote
// ganda; pembuat grup tidak bisa diturunkan.
let handler = async (m, { conn, text, participants, usedPrefix, command }) => {
  const targets = parseTargets({ mentionedJid: m.mentionedJid, quotedSender: m.quoted?.sender, text })
  if (!targets.length) throw `Siapa yang mau diturunkan jadi member biasa?\nContoh: ${usedPrefix + command} @tag — atau reply pesannya / ketik nomornya.`
  const lines = []
  for (const t of targets) {
    const p = findParticipant(participants, t)
    if (!p) { lines.push(`@${t.digits} — bukan member grup ini, tidak bisa diturunkan.`); continue }
    if (isCreatorParticipant(p)) { lines.push(`@${t.digits} — pembuat grup, tidak bisa diturunkan.`); continue }
    if (!isAdminParticipant(p)) { lines.push(`@${t.digits} — memang member biasa (bukan admin), tidak di-demote dua kali.`); continue }
    const [res] = await conn.groupParticipantsUpdate(m.chat, [t.id], 'demote') ?? []
    const status = String(res?.status ?? '')
    lines.push(status === '200' ? `@${t.digits} — sekarang member biasa ✅` : `@${t.digits} — gagal diturunkan (status ${status || 'tidak diketahui'}).`)
  }
  await conn.reply(m.chat, lines.join('\n'), m, { mentions: targets.map(t => t.id) })
}
handler.help = ['demote <@tag/reply/nomor>']; handler.tags = ['group']; handler.command = /^demote$/i
handler.group = true; handler.admin = true; handler.botAdmin = true
export default handler
