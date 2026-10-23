// Ambil nomor telepon (PN) seseorang tanpa ribet salin manual.
// Target: tag, reply, nomor yang diketik, atau — tanpa target — pengirim
// sendiri. Engine ini LID-first, jadi identitas diselesaikan lewat resolver
// identitas (conn.identity) supaya yang tampil nomor telepon aslinya,
// bukan angka LID.
let handler = async (m, { conn, text, participants }) => {
  const target = m.mentionedJid?.[0] ?? m.quoted?.sender ?? (String(text ?? '').trim() || m.sender)
  const result = await conn.identity.resolve(target, { m, participants })
  if (!result?.jid && !result?.lid) throw 'Target tidak ditemukan — tag orangnya, reply pesannya, atau ketik nomornya.'
  const lines = []
  if (result.jid) {
    const number = result.jid.split('@')[0]
    let name = ''
    try { name = await conn.getName(result.jid) } catch { /* nama hanya pelengkap */ }
    lines.push(`📱 *Nomor:* +${number}`)
    if (name && name !== 'Pengguna' && !name.startsWith('+')) lines.push(`👤 *Nama:* ${name}`)
    lines.push(`🔗 wa.me/${number}`)
  } else {
    lines.push('📱 *Nomor:* belum diketahui bot — identitas orang ini baru dikenal sebagai LID.')
  }
  if (result.lid) lines.push(`🆔 *LID:* ${result.lid.split('@')[0]}`)
  await m.reply(lines.join('\n'))
}
handler.help = ['n [@tag/reply/nomor]']; handler.tags = ['info']; handler.command = /^n$/i
export default handler
