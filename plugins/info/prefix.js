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
handler.tags = ['info']
handler.command = new RegExp()
handler.prefixless = /^(cek)?prefix$/i

export default handler