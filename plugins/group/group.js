// Pengaturan per grup: .group set — saat ini baru satu kunci, swgc
// (siapa yang boleh posting status grup): all | admin | none.
//
// SENGAJA belum dibuat kerangka umum (keputusan Veo 2026-10-31):
// kuncinya ditulis eksplisit di sini. Menambah kunci baru nanti =
// menambah cabang yang jelas di parseGroupSet + gerbang di plugin
// pemiliknya, bukan registry generik yang ditebak-tebak.
//
// Setting disimpan di record chats grup itu sendiri
// (global.db.data.chats[m.chat].swgc) — pola yang sama seperti
// banchat/unbanchat (lib/helpers/moderation.js): ensure, ubah field,
// save('chats').
//
// Yang boleh mengubah: admin grup (handler.admin) — konsisten dengan
// spek Veo bahwa .group set itu perintah admin. Perintah ini juga
// yang membaca mode berjalan bila dipanggil tanpa argumen.
import { SWGC_MODES, swgcMode } from './swgc.js'

const DESKRIPSI = {
  all: 'semua anggota boleh .swgc',
  admin: 'cuma admin grup yang boleh .swgc',
  none: '.swgc mati di grup ini',
}
const CONTOH = `.group set swgc <${SWGC_MODES.join('|')}>`

// Urai argumen sesudah ".group". Mengembalikan { show: true } untuk
// ".group" polos, atau { key: 'swgc', value } untuk set yang sah;
// sisanya string penolakan yang jelas.
export function parseGroupSet(args) {
  const [sub, key, value] = args ?? []
  if (!sub) return { show: true }
  if (sub !== 'set') throw `Formatnya: ${CONTOH}`
  if (key !== 'swgc') throw key
    ? `Setting "${String(key).slice(0, 30)}" tidak dikenal. Yang tersedia saat ini baru: swgc.\nContoh: ${CONTOH}`
    : `Kunci settingnya wajib diisi. Yang tersedia saat ini: swgc.\nContoh: ${CONTOH}`
  const v = String(value ?? '').toLowerCase()
  if (!SWGC_MODES.includes(v)) throw `Nilai buat swgc: ${SWGC_MODES.join(' / ')}.\nContoh: ${CONTOH}`
  return { key, value: v }
}

let handler = async (m, { chat, args }) => {
  const parsed = parseGroupSet(args)
  const current = swgcMode(chat)
  if (parsed.show) {
    await m.reply(`Mode .swgc grup ini sekarang: *${current}* (${DESKRIPSI[current]}).\nUbah dengan: ${CONTOH}`)
    return
  }
  const rec = globalThis.db.ensure('chats', m.chat)
  rec.swgc = parsed.value
  await globalThis.db.save('chats')
  await m.reply(`✅ Mode .swgc grup ini sekarang: *${parsed.value}* — ${DESKRIPSI[parsed.value]}.`)
}
handler.help = ['group set swgc <all|admin|none>']; handler.tags = ['group']; handler.command = ['group']
handler.group = true; handler.admin = true
export default handler
