let handler = async (m, { conn }) => {
  let currentPrefix = global.prefix

  // Konversi RegExp ke bentuk string yang bisa dibaca
  let prefixStr = Array.isArray(currentPrefix)
    ? currentPrefix.map(p => p.source).join(', ')
    : currentPrefix instanceof RegExp
      ? currentPrefix.source
      : currentPrefix

  m.reply(`📍 Prefix aktif saat ini:\n> ${prefixStr}`)
}

handler.help = ['cekprefix', 'prefix']
// Prefixless (handler.prefixless di bawah): tampil di menu di bawah
// kategori 'Tanpa Prefix', bukan 'info' — plugin tanpa prefix jangan
// masuk kategori lain (keputusan Veo 2026-11-25).
handler.tags = ['prefixless']
handler.command = new RegExp()
handler.prefixless = /^(cek)?prefix$/i

export default handler