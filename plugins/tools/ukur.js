// Hitung panjang teks: karakter, kata, baris, paragraf — adaptasi
// tools-ukurkata.js legacy, namanya dipendekkan jadi "ukur" (perintah
// founder) supaya gampang diketik, misalnya sebelum pasang deskripsi grup.
// Karakter dihitung per poin kode Unicode, jadi emoji terhitung 1 —
// mendekati cara WhatsApp menghitung batas teks.
let handler = async (m, { text, usedPrefix, command }) => {
  let input = String(text ?? '')
  if (!input && m.quoted) input = m.quoted.text || m.quoted.caption || ''
  if (!input.trim()) throw `Contoh penggunaan:\n${usedPrefix + command} teks yang ingin dihitung\n\nAtau reply sebuah pesan.`
  const chars = [...input].length
  const charsNoSpace = [...input.replace(/\s/g, '')].length
  const words = input.trim().split(/\s+/).filter(Boolean).length
  const lines = input.split('\n').length
  const paragraphs = input.split(/\n\s*\n/).filter(v => v.trim()).length
  await m.reply(
`📊 *Statistik Teks*

• Karakter: ${chars}
• Karakter (tanpa spasi): ${charsNoSpace}
• Kata: ${words}
• Baris: ${lines}
• Paragraf: ${paragraphs}`)
}
handler.help = ['ukur <teks>', 'ukur (reply pesan)']; handler.tags = ['tools']; handler.command = /^ukur$/i
export default handler
