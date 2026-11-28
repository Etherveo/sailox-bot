// Polling grup (native WhatsApp poll) — port plugins/group-polling.js
// legacy (legacy-bot), tanpa perubahan perilaku:
//
//   .poll Judul | opsi1 | opsi2 | ...
//   .poll -multi Judul | opsi1 | opsi2 | ...
//
// Tanpa -multi pemilih cuma bisa milih 1 opsi (selectableCount 1);
// dengan -multi boleh milih lebih dari satu (selectableCount 0 =
// tanpa batas, konvensi WhatsApp/Baileys). Khusus grup, siapa pun
// anggota grup boleh bikin polling — sama seperti polling bawaan WA,
// jadi tanpa gerbang admin. Fitur grup bebas limit (keputusan Veo
// 2026-11-25), jadi handler.limit sengaja tidak dipasang.
export const POLL_MAX_OPTIONS = 12
export const POLL_MAX_TITLE = 255
export const POLL_MAX_OPTION = 100

export function pollUsage(usedPrefix = '.') {
  return `Format:\n${usedPrefix}poll -multi Judul Polling | opsi1 | opsi2 | ...\n${usedPrefix}poll Judul Polling | opsi1 | opsi2 | ...`
}

// Parse teks perintah menjadi payload poll Baileys. Melempar string
// pesan pemakaian/validasi yang langsung jadi balasan ke pemanggil.
export function parsePollInput(rawText, usedPrefix = '.') {
  const text = String(rawText ?? '').trim()
  if (!text) throw pollUsage(usedPrefix)
  const args = text.split(/\s+/)
  const isMulti = args[0]?.toLowerCase() === '-multi'
  const input = (isMulti ? text.slice('-multi'.length) : text).trim()
  if (!input) throw 'Masukkan judul dan opsi polling.'
  const [judul, ...opsi] = input.split('|').map(v => v.trim())
  if (!judul) throw 'Judul polling tidak boleh kosong.'
  if (opsi.length < 2) throw 'Minimal harus ada 2 opsi.'
  if (opsi.length > POLL_MAX_OPTIONS) throw `Maksimal hanya ${POLL_MAX_OPTIONS} opsi yang diperbolehkan.`
  if (judul.length > POLL_MAX_TITLE) throw `Judul terlalu panjang (maks ${POLL_MAX_TITLE} karakter).`
  for (const o of opsi) {
    if (o.length > POLL_MAX_OPTION) throw `Ada opsi yang tidak valid:\n${o}\n\nPanjang bener, dah. Maks ${POLL_MAX_OPTION} karakter, yaa.`
  }
  return { name: judul, values: opsi, selectableCount: isMulti ? 0 : 1 }
}

let handler = async (m, { conn, text, usedPrefix }) => {
  const poll = parsePollInput(text, usedPrefix)
  try {
    await conn.sendMessage(m.chat, { poll })
  } catch (e) {
    throw `Gagal membuat polling:\n${e?.message || e}`
  }
}
handler.help = ['poll/polling -multi judul|opsi1|opsi2|...']; handler.tags = ['group']; handler.command = /^(poll(ing)?)$/i
handler.group = true
export default handler
