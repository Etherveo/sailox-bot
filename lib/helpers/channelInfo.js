// lib/helpers/channelInfo.js
//
// Cari ID + metadata saluran WhatsApp lewat API newsletter Baileys.
//
// Kenapa bukan .channellist: Baileys TIDAK punya endpoint "daftar semua
// saluran". Grup punya groupFetchAllParticipating, saluran tidak —
// socket newsletter hanya menyediakan metadata PER saluran, lewat
// newsletterMetadata('invite', kode) atau ('jid', jid). Jadi jalurnya
// dibalik: dari link/kode undangan (disalin dari aplikasi WA: Bagikan
// -> Salin link) atau JID yang sudah diketahui, tarik metadatanya —
// termasuk ID (JID) yang dibutuhkan `.config set botChannel`.
//
// Bentuk mentah metadata: parseNewsletterMetadata di Baileys hanya
// meneruskan respons Mex apa adanya, jadi bentuk runtime-nya adalah
// bentuk mentah (thread_metadata/viewer_metadata), BUKAN interface
// NewsletterMetadata yang datar di .d.ts. Normalizer di sini membaca
// kedua bentuk secara defensif, supaya tetap jalan kalau Baileys suatu
// hari benar-benar memparsing-nya.

export function parseChannelInput(raw) {
  const text = String(raw ?? '').trim()
  if (!text) throw 'Kirim salurannya: .channelinfo <link/kode/JID saluran>\nContoh: .channelinfo https://whatsapp.com/channel/0029VaAbCdEfGh'
  if (/^\d+@newsletter$/.test(text)) return { type: 'jid', key: text }
  const link = text.match(/(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/)
  if (link) return { type: 'invite', key: link[1] }
  if (/^\d{15,}$/.test(text)) return { type: 'jid', key: `${text}@newsletter` }
  if (/^[A-Za-z0-9_-]{5,64}$/.test(text)) return { type: 'invite', key: text }
  throw 'Format tidak dikenali. Kirim link saluran (whatsapp.com/channel/...), kode undangannya, atau JID-nya (120363xxx@newsletter).'
}

const asText = v => (v && typeof v === 'object' ? v.text : v) ?? undefined
const asInt = v => {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number.parseInt(String(v), 10)
  return Number.isFinite(n) ? n : undefined
}

// null = respons bukan metadata saluran (tidak ditemukan / bentuk asing).
export function normalizeChannelMetadata(raw) {
  if (!raw || typeof raw !== 'object') return null
  const thread = raw.thread_metadata ?? {}
  const viewer = raw.viewer_metadata ?? {}
  const id = raw.id
  if (!id || typeof id !== 'string') return null
  return {
    id,
    name: asText(raw.name) ?? asText(thread.name),
    description: asText(raw.description) ?? asText(thread.description),
    invite: raw.invite ?? thread.invite,
    subscribers: asInt(raw.subscribers) ?? asInt(thread.subscribers_count),
    verification: raw.verification ?? thread.verification,
    creationTime: asInt(raw.creation_time) ?? asInt(thread.creation_time),
    role: viewer.role,
    mute: raw.mute_state ?? viewer.mute,
    hasPicture: Boolean(raw.picture?.url ?? raw.picture?.directPath ?? thread.picture?.direct_path ?? thread.picture?.id),
  }
}

const ROLE_LABEL = { ADMIN: 'admin', OWNER: 'pemilik', GUEST: 'tamu', SUBSCRIBER: 'pengikut' }

function formatTime(sec) {
  const d = new Date(sec * 1000)
  if (Number.isNaN(d.getTime())) return undefined
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export function formatChannelInfo(info) {
  const lines = ['*Info saluran*']
  lines.push(`• Nama: ${info.name ?? '(tanpa nama)'}`)
  lines.push(`• ID: ${info.id}`)
  if (info.description) lines.push(`• Deskripsi: ${info.description}`)
  if (info.invite) lines.push(`• Link: https://whatsapp.com/channel/${info.invite}`)
  if (info.subscribers !== undefined) lines.push(`• Pengikut: ${info.subscribers.toLocaleString('id-ID')}`)
  if (info.verification) lines.push(`• Verifikasi: ${info.verification === 'VERIFIED' ? 'terverifikasi ✅' : 'tidak terverifikasi'}`)
  if (info.role) lines.push(`• Peran akun bot: ${ROLE_LABEL[info.role] ?? info.role}`)
  const created = info.creationTime ? formatTime(info.creationTime) : undefined
  if (created) lines.push(`• Dibuat: ${created}`)
  lines.push(`• Foto: ${info.hasPicture ? 'ada' : 'tidak ada'}`)
  if (info.role && !['ADMIN', 'OWNER'].includes(info.role)) {
    lines.push('⚠️ Akun bot bukan admin saluran ini — .bcc akan gagal sampai nomor bot dijadikan admin.')
  }
  lines.push('')
  lines.push(`Pasang jadi tujuan .bcc: .config set botChannel ${info.id}`)
  return lines.join('\n')
}
