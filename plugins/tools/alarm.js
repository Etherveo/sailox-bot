// plugins/tools/alarm.js
//
// Alarm harian (perintah Veo 2026-11-01): .alarm memasang alarm
// berulang setiap hari pada jam dinding + zona waktu tertentu
// (maks 3 per orang, jam+zona kembar ditolak), .alarmcheck
// mendaftar, .alarmdelete menghapus berdasarkan nomor daftar.
// Zona eksplisit yang dipakai tersimpan sebagai user.timezone dan
// menjadi bawaan alarm berikutnya. Pesan bebas opsional dalam
// tanda petik dua + flag tujuan bunyi -p / -d sama seperti .timer
// (tambahan perintah Veo 2026-11-02). Mesin penjadwalan +
// penyimpanan bersama .timer tinggal di lib/reminders/engine.js;
// plugin ini memegang tata bahasa perintah + tampilan.

import {
  tokenizeReminderInput, parseAlarmArgs, formatHHMM, formatFireDate,
  makeAlarmItem, sortedAlarms, assertAlarmSlot, pokeReminders, TZONES,
  MAX_ALARMS_PER_USER,
} from '#lib/reminders/engine.js'

const usage = usedPrefix =>
  `Pasang alarm dengan format jam + am/pm + zona waktu.\n` +
  `Contoh: ${usedPrefix}alarm 10:30 pm wita • ${usedPrefix}alarm 22:30 (format 24 jam)\n` +
  `Opsional: pesan dalam tanda petik, mis. ${usedPrefix}alarm 6:00 am "BANGUN WOY", dan flag -p supaya bunyi ke chat pribadi (bawaan -d: bunyi di chat ini).`

let handler = async (m, ctx) => {
  const { command, text, args, usedPrefix, userData: u } = ctx
  const now = ctx?.reminderNow ?? Date.now()
  if (!Array.isArray(u.alarms)) u.alarms = []

  if (command === 'alarm') {
    if (!text) throw usage(usedPrefix)
    let input
    try { input = tokenizeReminderInput(text) } catch (e) { throw String(e?.message ?? e) }
    if (!input.bare.length) throw usage(usedPrefix)
    let parsed
    try { parsed = parseAlarmArgs(input.bare, u.timezone ?? '') } catch (e) { throw String(e?.message ?? e) }
    if (!parsed.tzKey) {
      throw `Zona waktumu belum tercatat. Sertakan sekali ini (wib/wita/wit), mis. ${usedPrefix}alarm 10:30 pm wita — sesudah itu zona itu jadi bawaanmu.`
    }
    try { assertAlarmSlot(u, parsed) } catch (e) { throw String(e?.message ?? e) }
    const item = makeAlarmItem({ chat: m.chat, sender: m.sender, name: m.pushName }, parsed, now, { message: input.message, dest: input.dest })
    u.alarms.push(item)
    if (parsed.explicitTz) u.timezone = parsed.tzKey
    await global.db.save('users')
    pokeReminders()
    const tz = TZONES[parsed.tzKey]
    return m.reply(
      `🔔 Alarm dipasang: *${formatHHMM(parsed.hour, parsed.minute)} ${tz.label}* — berulang setiap hari.\n` +
      `Bunyi berikutnya: ${formatFireDate(item.nextFire, parsed.tzKey)}.` +
      (parsed.explicitTz ? `\nZona ${tz.label} kusimpan sebagai bawaanmu.` : '') +
      (input.message ? `\nPesan: "${input.message}"` : '') +
      `\nTujuan bunyi: ${input.dest === 'private' ? 'chat pribadi kamu' : 'chat ini'}.` +
      `\nAlarm aktifmu: ${u.alarms.length}/${MAX_ALARMS_PER_USER} — lihat dengan ${usedPrefix}alarmcheck`)
  }

  if (command === 'alarmcheck') {
    const list = sortedAlarms(u)
    if (!list.length) return m.reply(`Kamu belum punya alarm aktif. Pasang dengan ${usedPrefix}alarm <jam>, mis. ${usedPrefix}alarm 10:30 pm wita.`)
    const lines = list.map((a, i) =>
      `${i + 1}. ${formatHHMM(a.hour, a.minute)} ${(TZONES[a.tz]?.label ?? a.tz)} — berikutnya ${formatFireDate(a.nextFire, a.tz)}` +
      (a.message ? ` — "${a.message}"` : '') +
      (a.dest === 'private' ? ' (ke chat pribadi)' : ''))
    return m.reply(`🔔 *Alarm aktifmu (${list.length}/${MAX_ALARMS_PER_USER}):*\n${lines.join('\n')}\n\nHapus dengan ${usedPrefix}alarmdelete <nomor>`)
  }

  // alarmdelete
  const idx = Number(args[0])
  const list = sortedAlarms(u)
  if (!args[0] || !/^\d+$/.test(args[0]) || idx < 1 || idx > list.length) {
    throw list.length
      ? `Nomornya 1–${list.length}, sesuai daftar ${usedPrefix}alarmcheck.`
      : 'Kamu belum punya alarm aktif, tidak ada yang bisa dihapus.'
  }
  const item = list[idx - 1]
  u.alarms = u.alarms.filter(a => a.id !== item.id)
  await global.db.save('users')
  pokeReminders()
  return m.reply(`Alarm #${idx} (${formatHHMM(item.hour, item.minute)} ${(TZONES[item.tz]?.label ?? item.tz)}) dihapus.`)
}

handler.help = ['alarm <jam> [am/pm] [wib/wita/wit] ["pesan"] [-p/-d]', 'alarmcheck', 'alarmdelete <nomor>']
handler.tags = ['tools']
handler.command = /^(alarm|alarmcheck|alarmdelete)$/i

export default handler
