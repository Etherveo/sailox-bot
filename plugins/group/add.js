import { parseTargets, findParticipant } from '#lib/helpers/groupTargets.js'
// Tambah peserta ke grup (adaptasi group-add.js legacy). Target bisa dari
// nomor yang diketik, tag, atau reply. Yang sudah jadi member ditolak
// eksplisit — tidak ada tambah ganda. Kalau privasi target menolak
// penambahan langsung (status 403/408), bot mengirim undangan via DM,
// sama seperti legacy.
let handler = async (m, { conn, text, participants, groupMetadata, usedPrefix, command }) => {
  const targets = parseTargets({ mentionedJid: m.mentionedJid, quotedSender: m.quoted?.sender, text })
  if (!targets.length) throw `Siapa yang mau ditambahkan?\nContoh: ${usedPrefix + command} 628xxxxxxxxxx — atau tag/reply orangnya.`
  const lines = []
  const processed = new Set()
  for (const t of targets) {
    if (findParticipant(participants, t)) { lines.push(`@${t.digits} — sudah ada di grup, tidak ditambah dua kali.`); continue }
    const pn = await conn.toJid(t.id).catch(() => null)
    const key = pn ?? t.id
    if (processed.has(key)) continue
    processed.add(key)
    const [res] = await conn.groupParticipantsUpdate(m.chat, [t.id], 'add') ?? []
    const status = String(res?.status ?? '')
    if (status === '200') lines.push(`@${t.digits} — berhasil ditambahkan ✅`)
    else if (status === '409') lines.push(`@${t.digits} — sudah ada di grup.`)
    else if (status === '403' || status === '408') {
      try {
        const code = await conn.groupInviteCode(m.chat)
        await conn.sendMessage(res?.jid ?? key, { text: `Hai! Kamu diundang bergabung ke grup *${groupMetadata?.subject ?? 'ini'}*. Gabung lewat link ini ya: https://chat.whatsapp.com/${code}` })
        lines.push(`@${t.digits} — tidak bisa ditambah langsung (pengaturan privasinya), undangan dikirim ke DM-nya.`)
      } catch { lines.push(`@${t.digits} — tidak bisa ditambah langsung (privasi) dan undangan gagal dikirim.`) }
    } else lines.push(`@${t.digits} — gagal ditambahkan (status ${status || 'tidak diketahui'}).`)
  }
  await conn.reply(m.chat, lines.join('\n'), m, { mentions: targets.map(t => t.id) })
}
handler.help = ['add <nomor/@tag/reply>']; handler.tags = ['group']; handler.command = /^(add|tambah)$/i
handler.group = true; handler.admin = true; handler.botAdmin = true
export default handler
