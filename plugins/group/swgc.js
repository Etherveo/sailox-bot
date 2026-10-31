// Status grup: posting teks / gambar / video / audio sebagai STATUS
// grup ini (muncul di tab Status anggota grup, hilang 24 jam) —
// penerus group-swgc.js + owner-upswgc.js legacy, khusus admin grup.
//
// Kenapa tidak meniru legacy persis:
// - group-swgc legacy me-relay isi pesan mentah TANPA bungkus status
//   (yang terkirim pesan grup biasa / gagal), sedangkan upswgc membungkus
//   proto mentah hasil salinan pesan lama apa adanya.
// - Dokumentasi Baileys terbaru menulis API tingginya sebagai
//   conn.sendMessage(jid, { groupStatusMessage: { text } }), tetapi di
//   Baileys RESMI yang terpasang (7.0.0-rc14) bentuk itu belum
//   diimplementasikan: generateWAMessageContent melempar
//   "Invalid media type" (terverifikasi lokal 2026-10-31). Yang didukung
//   rc14 adalah field proto groupStatusMessageV2 (FutureProofMessage).
//   Jadi plugin ini melakukan sendiri terjemahan yang sama seperti fork
//   Baileys: isi pesan dibungkus ke groupStatusMessageV2 lalu dikirim
//   via relayMessage. Isi TEKS dirakit lewat generateWAMessageContent
//   resmi (terbukti tampil live).
//
// Perbaikan media 2026-10-31 malam (laporan Veo: teks tampil, media
// "pura-pura sukses" — bot membalas ✅ tapi statusnya tidak muncul).
// Bukti penentunya dump Veo dari status grup ASLI yang dibuat manual
// lewat fitur resmi WhatsApp: imageMessage di dalam
// groupStatusMessageV2 membawa contextInfo KHUSUS status —
//   isGroupStatus: true,
//   statusSourceType: IMAGE/VIDEO/AUDIO,
//   statusAttributions: [{ type: GROUP_STATUS,
//                           groupStatus: { authorJid: <LID pengirim> } }],
//   pairedMediaType: NOT_PAIRED_MEDIA,
//   featureEligibilities: { canReceiveMultiReact: true }
// Tanpa blok itu pesan terbungkus tidak didaftarkan sebagai status
// grup oleh server/klien. Karena itu media di sini TIDAK dirakit ulang
// (versi pertama mengunduh + mengunggah ulang lewat
// generateWAMessageContent — yang di lingkungan ini juga tidak
// menghasilkan jpegThumbnail/dimensi): proto media pesan sumber
// dipakai lagi apa adanya (salinan dalam via round-trip proto,
// caption disesuaikan) dan contextInfo-nya DIGANTI blok status di
// atas, dengan authorJid = identitas bot sendiri (conn.user.lid).
// Nilai enum ditulis ANGKA: encoder proto statis tidak menerjemahkan
// nama enum string (terverifikasi lokal — string lolos sebagai 0).
//
// Penyempurnaan dari dump status asli YANG DITERIMA bot (plugin
// diagnostik swgc-dump, 2026-10-31 21:46 — status manual Veo & akun
// bot di grup yang sama, foto yang sama dengan yang gagal via .swgc):
// (1) messageContextInfo.messageSecret duduk di level LUAR pesan
//     (sejajar groupStatusMessageV2), bukan di dalam inner message;
// (2) contextInfo media membawa forwardingScore: 0 secara eksplisit;
// (3) featureEligibilities lengkap: cannotBeRanked: false,
//     canBeReshared: false, canReceiveMultiReact: true.
// Ketiganya ditiru persis di bawah.
//
// Target selalu grup tempat perintah dipanggil (m.chat), jadi tidak
// ada jalur posting ke grup lain (legacy mengizinkannya — itu lubang
// wewenang, tidak diwarisi).
//
// Siapa yang boleh memakai diatur PER GRUP lewat mode di record chats
// grup itu (chats[m.chat].swgc, diatur admin grup dengan
// .group set swgc <all|admin|none>; spek Veo 2026-10-31):
//   all   = semua anggota boleh,
//   admin = cuma admin grup (bawaan sebelum diset),
//   none  = fitur mati di grup itu.
// Karena modenya berubah per grup, gerbangnya dicek di dalam handler —
// bukan flag statis handler.admin. Mode admin menuntut admin grup
// sungguhan (konsisten dengan aturan pipeline: admin tidak pernah
// di-bypass, termasuk oleh owner).
//
// botAdmin SENGAJA tidak dipasang: memposting status bukan operasi
// admin atas grup (beda dengan kick/add/promote yang mengubah member),
// dan legacy pun tidak memintanya. Bila WhatsApp ternyata menolak saat
// bot bukan admin, error mentahnya tampil ke pemanggil — bukan gagal diam.
import { generateWAMessageContent, proto, jidNormalizedUser, normalizeMessageContent, encodeWAMessage, generateMessageIDV2 } from '@whiskeysockets/baileys'
import { randomBytes } from 'node:crypto'
import { reactTo, REACT } from '#lib/helpers/react.js'
import { silentLogger } from '#lib/helpers/silentLogger.js'

export const SWGC_MAX_TEXT = 4096
export const SWGC_MODES = ['all', 'admin', 'none']

// Mode swgc efektif sebuah grup: nilai tersimpan yang sah dipakai apa
// adanya; belum diset / nilai asing jatuh ke 'admin' (bawaan aman —
// perilaku awal fitur ini memang khusus admin).
export function swgcMode(chat) {
  const v = String(chat?.swgc ?? 'admin').toLowerCase()
  return SWGC_MODES.includes(v) ? v : 'admin'
}

// Gerbang mode: melempar string penolakan yang langsung jadi balasan
// ke pemanggil. Dicek SEBELUM konten disiapkan — tidak ada unduh media
// atau unggah apa pun untuk pemanggil yang memang ditolak.
export function assertSwgcAllowed(mode, { isAdmin } = {}) {
  if (mode === 'none') throw 'Fitur .swgc lagi dimatikan di grup ini. Admin grup bisa menyalakannya lagi: .group set swgc admin (khusus admin) atau .group set swgc all (semua anggota).'
  if (mode === 'admin' && !isAdmin) throw 'Di grup ini .swgc cuma buat admin grup. Admin bisa melonggarkannya buat semua anggota: .group set swgc all'
}
const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage']
const USAGE = 'Kirim/reply gambar, video, atau audio dengan perintah ini, atau kasih teksnya sekalian.\nContoh: .swgc Halo semua! / reply foto dengan .swgc caption baru'

// Blok contextInfo penanda status grup, meniru persis struktur status
// asli dari fitur resmi WhatsApp (dump Veo 2026-10-31). Enum sebagai
// angka: PairedMediaType.NOT_PAIRED_MEDIA = 0; StatusSourceType
// IMAGE = 0, VIDEO = 1, GIF = 2, AUDIO = 3; StatusAttribution
// Type.GROUP_STATUS = 5. authorJid = LID pengirim status (bot sendiri).
export function statusContextInfo(type, inner, authorJid) {
  const sourceType = type === 'imageMessage' ? 0 : type === 'audioMessage' ? 3 : inner?.gifPlayback ? 2 : 1
  return {
    // forwardingScore + featureEligibilities lengkap (termasuk false
    // eksplisit) meniru dump status asli yang diterima bot 2026-10-31
    // 21:46 — field-field itu ter-encode di wire aslinya, bukan bawaan.
    forwardingScore: 0,
    featureEligibilities: { cannotBeRanked: false, canBeReshared: false, canReceiveMultiReact: true },
    pairedMediaType: 0,
    statusSourceType: sourceType,
    statusAttributions: [{ type: 5, groupStatus: { authorJid: String(authorJid ?? '') } }],
    isGroupStatus: true,
  }
}

// Pakai ulang proto media pesan sumber sebagai isi status. Salinan
// dalam lewat round-trip encode/decode proto (Buffer aman — bukan
// JSON). contextInfo sumber (rujukan ke pesan asal: stanzaId, pesan
// kutipan, mention) DIGANTI blok penanda status grup — tanpa blok itu
// status media tidak pernah tampil. `caption` undefined = pertahankan
// caption sumber; string (termasuk '') = paksa jadi caption itu.
// Audio tidak menerima caption.
export function reuseMediaContent(src, caption, authorJid) {
  const type = src?.mtype
  if (!MEDIA_TYPES.includes(type) || !src.msg) throw 'Media sumbernya tidak lengkap — coba kirim ulang medianya ya.'
  const copy = proto.Message.decode(proto.Message.encode(proto.Message.create({ [type]: src.msg })).finish())
  const inner = copy[type]
  if ((type === 'imageMessage' || type === 'videoMessage') && caption !== undefined) inner.caption = caption
  inner.contextInfo = statusContextInfo(type, inner, authorJid)
  return { [type]: inner }
}

// Rakit isi (inner message) status grup dari pesan perintah:
// - media pada pesan perintah sendiri didahulukan, lalu media pada
//   pesan yang di-reply → proto media sumber dipakai ulang, dengan
//   authorJid = identitas pengirim (bot) untuk atribusi status.
// - tanpa media → teks perintah, dirakit generator resmi.
// `generate` bisa diinjeksi untuk tes.
export async function buildSwgcInner(m, rawText, generate = generateWAMessageContent, authorJid = '') {
  const caption = String(rawText ?? '').trim()
  if (caption.length > SWGC_MAX_TEXT) throw `Teks/caption-nya kepanjangan (maks ${SWGC_MAX_TEXT} karakter).`
  const own = MEDIA_TYPES.includes(m?.mtype) ? m : null
  const quoted = !own && m?.quoted && MEDIA_TYPES.includes(m.quoted.mtype) ? m.quoted : null
  const src = own ?? quoted
  if (!src) {
    if (!caption) throw USAGE
    // linkPreview: null — status teks tidak perlu pratinjau tautan, dan
    // generateWAMessageContent jadi tidak memanggil getUrlInfo sama sekali.
    return generate({ text: caption, linkPreview: null }, { logger: silentLogger })
  }
  // Media dari pesan perintah sendiri: caption aslinya adalah perintah
  // itu sendiri, jadi caption dipaksa dari teks sesudah perintah (boleh
  // kosong). Media reply: teks baru menimpa; tanpa teks, caption sumber
  // dipertahankan (undefined).
  return reuseMediaContent(src, own ? caption : (caption || undefined), authorJid)
}

// --- Relay grup ala fork (temuan 2026-10-31 malam, dari bedah
// @pontalabs/baileys 1.2.5 yang dipakai yue-bot — bot yang .upswgc-nya
// TERBUKTI bisa): di relayMessage fork itu, atribut `mediatype` pada
// node <enc> dihitung dari pesan yang sudah di-NORMALISASI
// (normalizeMessageContent membuka bungkus groupStatusMessageV2 →
// media di dalamnya ketahuan: 'image'/'video'). Di Baileys RESMI rc14
// baris yang sama membaca pesan MENTAH terbungkus, hasilnya selalu
// kosong — stanza status media kita selama ini berangkat TANPA
// mediatype, dan statusnya tidak pernah didaftarkan. Selisih kedua:
// audio terbungkus status → fork memaksa stanza type 'text' dan tanpa
// mediatype ("Baileys behavior" di komentar kodenya).
//
// relayMessage bawaan tidak memberi jalan menyuntik atribut node enc
// dari luar, jadi untuk MEDIA plugin ini merakit sendiri stanza grup
// sender-key memakai potongan soket yang memang terekspos
// (signalRepository.encryptGroupMessage, groupMetadata, authState,
// sendNode) — transkripsi setia cabang grup relayMessage rc14 plus
// dua perilaku fork di atas. Penyederhanaan yang disengaja: distribusi
// sender-key BARU tidak dilakukan di sini; relay kustom hanya dipakai
// bila sender key bot untuk grup itu sudah terbentuk dan sudah pernah
// terdistribusi (sender-key-memory tidak kosong — keadaan normal grup
// aktif). Di luar itu, jatuh kembali ke relayMessage bawaan (yang
// menangani distribusi dengan benar; status mungkin tak terdaftar,
// tapi pesan terkirim seperti perilaku lama dan alasannya tercatat).
export function forkMediaType(message) {
  // Fork: audio di dalam groupStatusMessageV2 tidak diberi mediatype.
  if (message?.groupStatusMessageV2?.message?.audioMessage) return undefined
  const normalized = normalizeMessageContent(message)
  if (normalized?.imageMessage) return 'image'
  if (normalized?.videoMessage) return normalized.videoMessage.gifPlayback ? 'gif' : 'video'
  if (normalized?.audioMessage) return normalized.audioMessage.ptt ? 'ptt' : 'audio'
  return undefined
}

export function forkStanzaType(message) {
  if (message?.groupStatusMessageV2?.message?.audioMessage) return 'text'
  return forkMediaType(message) ? 'media' : 'text'
}

export async function relayGroupStatusMedia(conn, chat, payload) {
  const creds = conn.authState?.creds
  const meId = creds?.me?.id
  const meLid = creds?.me?.lid
  if (!meId || !conn.signalRepository?.encryptGroupMessage || !conn.sendNode || !conn.groupMetadata) {
    console.log('[swgc] relay fork-style tidak tersedia (potongan soket kurang) — fallback relayMessage bawaan')
    return conn.relayMessage(chat, payload, {})
  }
  const groupData = await conn.groupMetadata(chat)
  const addressingMode = groupData?.addressingMode || 'lid'
  const groupSenderIdentity = addressingMode === 'lid' && meLid ? meLid : meId
  const [hasKey, senderKeyMap] = await Promise.all([
    conn.signalRepository.hasSenderKey({ group: chat, meId: groupSenderIdentity }).catch(() => false),
    conn.authState.keys.get('sender-key-memory', [chat]).then(r => r?.[chat] || {}).catch(() => ({})),
  ])
  if (!hasKey || !Object.keys(senderKeyMap).length) {
    console.log(`[swgc] relay fork-style dilewati: sender key grup belum siap (hasKey=${!!hasKey}, memori=${Object.keys(senderKeyMap).length}) — fallback relayMessage bawaan`)
    return conn.relayMessage(chat, payload, {})
  }
  const mediaType = forkMediaType(payload)
  const bytes = encodeWAMessage(payload)
  const { ciphertext } = await conn.signalRepository.encryptGroupMessage({ group: chat, data: bytes, meId: groupSenderIdentity })
  const stanza = {
    tag: 'message',
    attrs: {
      id: generateMessageIDV2(meId),
      to: chat,
      type: forkStanzaType(payload),
      addressing_mode: addressingMode,
      ...(groupData?.ephemeralDuration > 0 ? { expiration: String(groupData.ephemeralDuration) } : {}),
    },
    content: [{ tag: 'enc', attrs: { v: '2', type: 'skmsg', ...(mediaType ? { mediatype: mediaType } : {}) }, content: ciphertext }],
  }
  await conn.sendNode(stanza)
  console.log(`[swgc] relay fork-style terkirim: grup=${chat} id=${stanza.attrs.id} mediatype=${mediaType ?? '(tanpa)'} stanzaType=${stanza.attrs.type}`)
  return { key: { id: stanza.attrs.id, remoteJid: chat, fromMe: true } }
}

// Bungkus isi menjadi status grup dan kirim. messageContextInfo.
// messageSecret ditaruh di level LUAR (sejajar bungkus status), persis
// seperti struktur status asli yang diterima bot pada dump 2026-10-31
// 21:46 — BUKAN di dalam inner message. Media dikirim lewat relay
// fork-style di atas (supaya mediatype benar); teks tetap lewat
// relayMessage bawaan yang sudah terbukti tampil.
export async function sendGroupStatus(conn, chat, inner) {
  const payload = {
    messageContextInfo: { messageSecret: randomBytes(32) },
    groupStatusMessageV2: { message: inner },
  }
  if (MEDIA_TYPES.some(t => inner?.[t])) return relayGroupStatusMedia(conn, chat, payload)
  return conn.relayMessage(chat, payload, {})
}

// Identitas bot untuk atribusi status (authorJid), mengikuti logika
// relayMessage Baileys: identitas pengirim grup ditentukan mode alamat
// grup (addressingMode) — mode 'lid' memakai LID bot, selain itu PN.
// authorJid yang tidak cocok dengan participant di key pesan berisiko
// dibuang diam-diam oleh klien penerima.
export function swgcAuthorJid(conn, groupMetadata) {
  const mode = groupMetadata?.addressingMode || 'lid'
  const raw = mode === 'lid' && conn?.user?.lid ? conn.user.lid : (conn?.user?.id || conn?.user?.lid || '')
  // conn.user.lid bisa membawa sufiks device ("123456:6@lid") — dump
  // status asli menunjukkan authorJid selalu JID bersih tanpa device.
  return raw ? jidNormalizedUser(raw) : ''
}

let handler = async (m, { conn, text, chat, isAdmin, groupMetadata }) => {
  // Diagnostik penuh per tahap (permintaan Veo 2026-10-31): kegagalan
  // fitur ini selama ini DIAM — handler tuntas, log panel bersih, tapi
  // statusnya tidak tampil. Sekarang setiap percobaan meninggalkan
  // jejak [swgc] di terminal: gerbang, identitas, ringkasan payload,
  // dan hasil relay. Error mentah selalu console.error apa adanya.
  const mode = swgcMode(chat)
  try {
    assertSwgcAllowed(mode, { isAdmin })
  } catch (e) {
    console.log(`[swgc] ditolak gerbang: grup=${m.chat} mode=${mode} isAdmin=${!!isAdmin} — ${String(e)}`)
    throw e
  }
  const authorJid = swgcAuthorJid(conn, groupMetadata)
  console.log(`[swgc] percobaan: grup=${m.chat} mode=${mode} authorJid=${authorJid || '(KOSONG)'} user.lid=${conn.user?.lid ? 'ada' : 'KOSONG'} user.id=${conn.user?.id ? 'ada' : 'KOSONG'} addressingMode=${groupMetadata?.addressingMode || '(bawaan: lid)'}`)
  let inner
  try {
    inner = await buildSwgcInner(m, text, undefined, authorJid)
  } catch (e) {
    if (e instanceof Error) console.error('[swgc] gagal menyiapkan isi status:', e)
    else console.log(`[swgc] isi ditolak: grup=${m.chat} — ${String(e)}`)
    throw e
  }
  const innerType = MEDIA_TYPES.find(t => inner?.[t]) ?? (inner?.extendedTextMessage ? 'extendedTextMessage' : '(tidak dikenal)')
  const media = inner?.[innerType]
  console.log(`[swgc] isi siap: tipe=${innerType} grup=${m.chat}` + (MEDIA_TYPES.includes(innerType)
    ? ` thumb=${media.jpegThumbnail ? Buffer.from(media.jpegThumbnail).length : 0}B scansSidecar=${media.scansSidecar ? 'ada' : 'tidak'} midQuality=${media.midQualityFileSha256 ? 'ada' : 'tidak'} msgSecret=outer@relay contextInfo=${JSON.stringify(media.contextInfo ?? null)}`
    : ` teks=${JSON.stringify(String(media?.text ?? '').slice(0, 60))}`))
  await reactTo(m, REACT.processing).catch(() => {})
  let result
  try {
    result = await sendGroupStatus(conn, m.chat, inner)
  } catch (e) {
    console.error('[swgc] gagal mengirim status grup:', e)
    await reactTo(m, REACT.error).catch(() => {})
    throw `Gagal mengirim status grup: ${String(e?.message ?? e).slice(0, 300)}`
  }
  console.log(`[swgc] relay OK: grup=${m.chat} hasil=${result ? `keys=${Object.keys(result).join(',')} id=${result.key?.id ?? '-'} status=${result.status ?? '-'}` : 'null (relayMessage rc14 tidak mengembalikan pesan)'}`)
  await reactTo(m, REACT.done).catch(() => {})
  await m.reply('✅ Status grup terkirim — bisa dilihat anggota grup di tab Status.')
}
handler.help = ['swgc <teks>', 'swgc (kirim/reply gambar/video/audio)']; handler.tags = ['group']; handler.command = ['swgc', 'upswgc', 'swgroup']
handler.group = true
export default handler
