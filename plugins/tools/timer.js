// plugins/tools/timer.js
//
// Timer sekali-jalan (perintah Veo 2026-11-01): .timer memasang
// hitung mundur (maks 3 per orang, deadline kembar persis ditolak,
// 1 detik–24 jam), .timercheck mendaftar, .timerdelete menghapus
// berdasarkan nomor daftar. Pesan bebas opsional dalam tanda petik
// dua (validasi ketat di engine) + flag tujuan bunyi -p (chat
// pribadi) / -d (chat ini, bawaan) — tambahan perintah Veo
// 2026-11-02. Mesin penjadwalan + penyimpanan bersama .alarm
// tinggal di lib/reminders/engine.js (engine keluarga pengingat);
// plugin ini memegang tata bahasa perintah + tampilan.

import {
  tokenizeReminderInput, parseDurationMs, formatDuration, formatClockWithTz,
  makeTimerItem, sortedTimers, assertTimerSlot, pokeReminders, MAX_TIMERS_PER_USER,
} from '#lib/reminders/engine.js'

const usage = usedPrefix =>
  `Pasang timer dengan durasi angka + satuan s/m/h (tanpa satuan = menit).\n` +
  `Contoh: ${usedPrefix}timer 50s • ${usedPrefix}timer 15 • ${usedPrefix}timer 1h30m • ${usedPrefix}timer 23h 59m 59s\n` +
  `Opsional: pesan dalam tanda petik, mis. ${usedPrefix}timer 50m "NASINYA HANGUSSS", dan flag -p supaya bunyi ke chat pribadi (bawaan -d: bunyi di chat ini).`

let handler = async (m, ctx) => {
  const { command, text, args, usedPrefix, userData: u } = ctx
  const now = ctx?.reminderNow ?? Date.now()
  if (!Array.isArray(u.timers)) u.timers = []

  if (command === 'timer') {
    if (!text) throw usage(usedPrefix)
    let input
    try { input = tokenizeReminderInput(text) } catch (e) { throw String(e?.message ?? e) }
    if (!input.bare.length) throw usage(usedPrefix)
    let ms
    try { ms = parseDurationMs(input.bare.join(' ')) } catch (e) { throw String(e?.message ?? e) }
    const deadline = now + ms
    try { assertTimerSlot(u, deadline) } catch (e) { throw String(e?.message ?? e) }
    u.timers.push(makeTimerItem({ chat: m.chat, sender: m.sender, name: m.pushName }, ms, now, { message: input.message, dest: input.dest }))
    await global.db.save('users')
    pokeReminders()
    return m.reply(
      `⏰ Timer dipasang: *${formatDuration(ms)}*\n` +
      `Bunyi ${formatClockWithTz(deadline, global.timezone ?? 'Asia/Jakarta')}.\n` +
      (input.message ? `Pesan: "${input.message}"\n` : '') +
      `Tujuan bunyi: ${input.dest === 'private' ? 'chat pribadi kamu' : 'chat ini'}.\n` +
      `Timer aktifmu: ${u.timers.length}/${MAX_TIMERS_PER_USER} — lihat dengan ${usedPrefix}timercheck`)
  }

  if (command === 'timercheck') {
    const list = sortedTimers(u)
    if (!list.length) return m.reply(`Kamu belum punya timer aktif. Pasang dengan ${usedPrefix}timer <durasi>, mis. ${usedPrefix}timer 15m.`)
    const lines = list.map((t, i) =>
      `${i + 1}. ${formatDuration(t.durationMs)} — sisa ${formatDuration(t.deadline - now)} (bunyi ${formatClockWithTz(t.deadline, global.timezone ?? 'Asia/Jakarta')})` +
      (t.message ? ` — "${t.message}"` : '') +
      (t.dest === 'private' ? ' (ke chat pribadi)' : ''))
    return m.reply(`⏰ *Timer aktifmu (${list.length}/${MAX_TIMERS_PER_USER}):*\n${lines.join('\n')}\n\nHapus dengan ${usedPrefix}timerdelete <nomor>`)
  }

  // timerdelete
  const idx = Number(args[0])
  const list = sortedTimers(u)
  if (!args[0] || !/^\d+$/.test(args[0]) || idx < 1 || idx > list.length) {
    throw list.length
      ? `Nomornya 1–${list.length}, sesuai daftar ${usedPrefix}timercheck.`
      : 'Kamu belum punya timer aktif, tidak ada yang bisa dihapus.'
  }
  const item = list[idx - 1]
  u.timers = u.timers.filter(t => t.id !== item.id)
  await global.db.save('users')
  pokeReminders()
  return m.reply(`Timer #${idx} (${formatDuration(item.durationMs)}) dihapus.`)
}

handler.help = ['timer <durasi> ["pesan"] [-p/-d]', 'timercheck', 'timerdelete <nomor>']
handler.tags = ['tools']
handler.command = /^(timer|timercheck|timerdelete)$/i

export default handler
