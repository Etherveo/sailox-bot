// Balas dengan tag yang bisa diklik (hijau) untuk diri sendiri — atau
// untuk target dari tag/reply/nomor. Kuncinya bukan teks "@angka" saja:
// teks harus berisi @<digit> DAN mentions harus berisi JID orang itu,
// karena tanpa mentions WhatsApp hanya menampilkan string literal yang
// tidak bisa diklik. Digit tampilan diambil dari identitas yang sudah
// di-resolve (nomor telepon bila dikenal, LID bila hanya itu yang ada),
// supaya cocok dengan bentuk JID yang dikirim sebagai mention.
let handler = async (m, { conn, text, participants }) => {
  const target = m.mentionedJid?.[0] ?? m.quoted?.sender ?? (String(text ?? '').trim() || m.sender)
  const result = await conn.identity.resolve(target, { m, participants })
  if (!result?.jid && !result?.lid) throw 'Target tidak ditemukan — tag orangnya, reply pesannya, atau ketik nomornya.'
  const mentionId = result.jid ?? result.lid
  const digits = mentionId.split('@')[0]
  await conn.reply(m.chat, `@${digits}`, m, { mentions: [mentionId] })
}
handler.help = ['tagme [@tag/reply/nomor]']; handler.tags = ['tools', 'info']; handler.command = /^tagme$/i
handler.sharing = true
export default handler
