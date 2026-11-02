// Penolong bersama plugin-plugin grup: mengambil target dari tag (mention),
// reply, dan/atau nomor yang diketik, lalu mencocokkannya ke daftar peserta.
//
// Grup engine ini LID-first: satu orang bisa muncul sebagai JID nomor
// telepon (PN) atau sebagai LID, dan entri peserta membawa ketiga bentuknya
// (id, lid, phoneNumber). Pencocokan di sini membandingkan digit dari semua
// bentuk itu, jadi target dari sumber mana pun tetap ketemu orangnya.
import { phoneDigits } from '../identity/resolver.js'

export const MAX_TARGETS = 10

export const digitsOf = id => String(id ?? '').split('@')[0].split(':')[0].replace(/\D/g, '')

// Sumber target, urut prioritas: mention -> pengirim pesan yang di-reply ->
// nomor yang diketik bebas di teks. Hasil unik berdasar digit, dibatasi
// MAX_TARGETS supaya satu perintah tidak menyapu terlalu banyak orang.
export function parseTargets({ mentionedJid = [], quotedSender = null, text = '' } = {}) {
  const out = []
  const seen = new Set()
  const push = id => {
    if (!id) return
    const digits = digitsOf(id)
    if (!digits || seen.has(digits)) return
    seen.add(digits)
    out.push({ id: String(id), digits })
  }
  for (const id of mentionedJid ?? []) push(id)
  push(quotedSender)
  const chunks = String(text ?? '').match(/\+?\d[\d\s.-]{5,}\d/g) ?? []
  for (const chunk of chunks) {
    const digits = phoneDigits(chunk)
    if (digits) push(`${digits}@s.whatsapp.net`)
  }
  return out.slice(0, MAX_TARGETS)
}

// Teks hasil dan daftar mentions harus memakai bentuk identitas yang sama.
// Target dari tag/reply umumnya tiba sebagai LID, sedangkan mentions yang
// dikirim bot dinormalisasi identity.forAction ke bentuk aktif (PN bila
// nomornya dikenal). Bila plugin menampilkan digit LID tetapi mentions
// berisi PN — atau sebaliknya — WhatsApp tidak mengaitkan keduanya dan
// hasil akhirnya cuma teks "@angka" polos. Fungsi ini meminta bentuk
// mention final lebih dulu, lalu plugin memakai digit dari bentuk itu
// untuk label tampilannya (pola yang sama seperti .tagme).
export async function resolveMentionTargets(conn, targets, ctx = {}) {
  return Promise.all((targets ?? []).map(async target => {
    let mentionId = target.id
    try {
      const resolved = await conn?.identity?.forAction?.([target.id], 'mention', ctx)
      if (Array.isArray(resolved) && resolved[0]) mentionId = String(resolved[0])
    } catch { /* Pakai identitas target asli sebagai fallback. */ }
    const mentionDigits = digitsOf(mentionId) || target.digits
    return { ...target, mentionId, mentionDigits, mentionLabel: `@${mentionDigits}` }
  }))
}

export function findParticipant(participants, target) {
  const digits = digitsOf(typeof target === 'string' ? target : target?.id)
  if (!digits) return null
  return (participants ?? []).find(p => [p?.id, p?.lid, p?.phoneNumber].some(v => v && digitsOf(v) === digits)) ?? null
}

export const isAdminParticipant = p => p?.admin === 'admin' || p?.admin === 'superadmin'
export const isCreatorParticipant = p => p?.admin === 'superadmin'
