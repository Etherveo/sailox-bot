let handler = async (m, { conn, usedPrefix, command }) => {
  try {
    if (!m.quoted) throw '⚠️ Reply pesan yang ingin di-inspect, Senpai!'

    let msg = await conn.loadMessage(m.quoted.id) // Ambil isi asli pesan yg direply
    if (!msg) throw '⚠️ Gagal mengambil pesan. Mungkin terlalu lama atau tidak ada?'

    let json = JSON.stringify(msg, null, 2)

    if (json.length > 65000) {
      // Kalau terlalu panjang, kirim sebagai dokumen txt
      const fileName = `dump-${+new Date()}.txt`
      await conn.sendMessage(m.chat, {
        document: Buffer.from(json),
        fileName,
        mimetype: 'text/plain'
      }, { quoted: m })
    } else {
      await m.reply('json\n' + json + '\n')
    }

  } catch (e) {
    console.error(e)
    m.reply(`❌ Error: ${e}`)
  }
}

handler.help = ['dump']
handler.tags = ['owner']
handler.command = /^(dump)$/i
handler.founder = true

export default handler