import { toDataURL } from 'qrcode'

let handler = async (m, { conn, text, usedPrefix, command }) => {
  if (!text || !text.trim()) throw `Contoh penggunaan:\n${usedPrefix + command} google.com`
  let url
  try {
    url = await toDataURL(text.slice(0, 2048), { scale: 8 })
  } catch {
    throw 'Maks 2048 karakter.'
  }
  await conn.sendFile(m.chat, url, 'qrcode.png', 'Nih.', m)
}
handler.help = ['qr <teks>', 'qrcode <teks>']; handler.tags = ['tools']; handler.command = /^qr(code)?$/i
handler.sharing = true;

export default handler