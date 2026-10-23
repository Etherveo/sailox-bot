// Helper reaksi WhatsApp untuk semua plugin.
//
// Kenapa helper ini ada: reaksi harus menempel PERSIS pada pesan yang mau
// ditanggapi. conn.sendReact/sendMessage mentah menerima jid + key terpisah,
// jadi pemanggil bisa saja memasangkan key pesan A dengan jid chat B —
// reaksinya nyasar atau gagal diam-diam. Helper ini mengunci target dari
// key pesan itu sendiri: reactTo(m, emoji) menurunkan remoteJid + id +
// participant dari m.key, dan tidak menerima jid bebas dari pemanggil.
//
// Pakai:
//   import { reactTo, REACT } from '#lib/helpers/react.js'
//   await reactTo(m, REACT.processing)   // ⏳ pada pesan m
//   await reactTo(m, '🔥')               // emoji bebas

export const REACT = Object.freeze({
  processing: '⏳', // sedang diproses — respon awal plugin berat
  done: '✅',
  received: '👍',
  chat: '💬',
  bye: '👋',
  error: '⚠️',
})

const MAX_EMOJI_CODEPOINTS = 16

export function assertEmoji(emoji) {
  if (typeof emoji !== 'string' || !emoji.trim()) throw new Error('Emoji reaksi wajib diisi')
  const clean = emoji.trim()
  if ([...clean].length > MAX_EMOJI_CODEPOINTS) throw new Error('Emoji reaksi terlalu panjang')
  return clean
}

// Turunkan MessageKey reaksi dari pesan serial (m). Melempar bila key tidak
// lengkap — reaksi tanpa remoteJid/id yang jelas tidak boleh dikirim.
export function reactionKey(m) {
  const key = m?.key
  if (!key?.remoteJid || !key?.id) throw new Error('Pesan tidak punya key lengkap (remoteJid/id) untuk direact')
  const out = { remoteJid: key.remoteJid, fromMe: !!key.fromMe, id: key.id }
  if (key.participant) out.participant = key.participant
  return out
}

function assertKey(key) {
  if (!key?.remoteJid || !key?.id) throw new Error('Key reaksi tidak lengkap (remoteJid/id wajib)')
  const out = { remoteJid: key.remoteJid, fromMe: !!key.fromMe, id: key.id }
  if (key.participant) out.participant = key.participant
  return out
}

// Tingkat rendah: kirim reaksi dari key mentah (mis. dari store). Target
// selalu key.remoteJid — tidak ada parameter jid yang bisa membelokkannya.
export async function sendReaction(conn, key, emoji) {
  if (typeof conn?.sendMessage !== 'function') throw new Error('Koneksi tidak tersedia untuk mengirim reaksi')
  const k = assertKey(key)
  return conn.sendMessage(k.remoteJid, { react: { text: assertEmoji(emoji), key: k } })
}

// Cara utama: react pada pesan serial m (yang diterima handler plugin).
export async function reactTo(m, emoji, { conn = m?.conn } = {}) {
  return sendReaction(conn, reactionKey(m), emoji)
}

// Preset respon awal "sedang diproses" — pola paling umum untuk plugin.
export const reactProcessing = (m, opts) => reactTo(m, REACT.processing, opts)
