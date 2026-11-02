// tests/reminders.test.js — fitur pengingat (lib/reminders/engine.js +
// plugins/tools/timer.js + plugins/tools/alarm.js): penguraian durasi
// & jam, matematika zona waktu, gerbang slot (maks 3, deadline/jam
// kembar), alur plugin, dan scheduler (bunyi, telat, lewati alarm basi).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDurationMs, parseAlarmArgs, nextAlarmFireMs, formatDuration,
  makeTimerItem, makeAlarmItem, createReminderScheduler, TZONES,
  tokenizeReminderInput,
} from '../lib/reminders/engine.js'
import timerHandler from '../plugins/tools/timer.js'
import alarmHandler from '../plugins/tools/alarm.js'

global.timezone = 'Asia/Makassar'

/* ─── Parser durasi ──────────────────────────────────────────────────────── */

test('parseDurationMs: bentuk polos, menempel, berjarak, kombo', () => {
  assert.equal(parseDurationMs('50'), 50 * 60000, 'tanpa satuan = menit')
  assert.equal(parseDurationMs('50s'), 50000)
  assert.equal(parseDurationMs('50 s'), 50000)
  assert.equal(parseDurationMs('15m'), 15 * 60000)
  assert.equal(parseDurationMs('1h 30'), 90 * 60000, 'segmen tanpa satuan di kombo = menit')
  assert.equal(parseDurationMs('23h59m59s'), 86399000)
  assert.equal(parseDurationMs('23h 59m 59s'), 86399000)
  assert.equal(parseDurationMs('24h'), 86400000, 'tepat 24 jam boleh')
})

test('parseDurationMs: menolak kosong, sampah, di bawah 1 detik, di atas 24 jam', () => {
  assert.throws(() => parseDurationMs(''), /belum diisi/)
  assert.throws(() => parseDurationMs('abc'), /tidak dikenal/)
  assert.throws(() => parseDurationMs('1.5h'), /tidak dikenal/)
  assert.throws(() => parseDurationMs('0s'), /minimal 1 detik/)
  assert.throws(() => parseDurationMs('0'), /minimal 1 detik/)
  assert.throws(() => parseDurationMs('25h'), /maksimal 24 jam/)
  assert.throws(() => parseDurationMs('24h0m1s'), /maksimal 24 jam/)
})

test('formatDuration: jam/menit/detik terbaca', () => {
  assert.equal(formatDuration(86399000), '23 jam 59 menit 59 detik')
  assert.equal(formatDuration(50000), '50 detik')
  assert.equal(formatDuration(3000000), '50 menit')
  assert.equal(formatDuration(3600000), '1 jam')
})

/* ─── Parser alarm + zona waktu ──────────────────────────────────────────── */

test('parseAlarmArgs: 12 jam + am/pm, 24 jam, zona eksplisit/bawaan', () => {
  assert.deepEqual(parseAlarmArgs(['10:30', 'pm', 'wita'], ''), { hour: 22, minute: 30, tzKey: 'wita', explicitTz: true })
  assert.deepEqual(parseAlarmArgs(['10:30', 'am'], 'wib'), { hour: 10, minute: 30, tzKey: 'wib', explicitTz: false })
  assert.equal(parseAlarmArgs(['12:00', 'pm'], 'wita').hour, 12, '12 pm = siang')
  assert.equal(parseAlarmArgs(['12:00', 'am'], 'wita').hour, 0, '12 am = tengah malam')
  assert.equal(parseAlarmArgs(['12:00'], 'wita').hour, 12, '12:00 tanpa am/pm = siang')
  assert.equal(parseAlarmArgs(['22:30'], 'wit').hour, 22)
  assert.equal(parseAlarmArgs(['13:00', 'pm'], 'wita').hour, 13, 'jam >12: am/pm gugur')
  assert.equal(parseAlarmArgs(['07:15', 'wita'], '').hour, 7)
  assert.equal(parseAlarmArgs(['07:15'], '').tzKey, null, 'tanpa zona & tanpa bawaan -> null')
})

test('parseAlarmArgs: menolak jam liar dan token asing', () => {
  assert.throws(() => parseAlarmArgs(['25:00'], 'wita'), /di luar rentang/)
  assert.throws(() => parseAlarmArgs(['10:70'], 'wita'), /di luar rentang/)
  assert.throws(() => parseAlarmArgs(['10:30', 'xyz'], 'wita'), /tidak dikenal/)
  assert.throws(() => parseAlarmArgs(['setengah', 'sepuluh'], 'wita'), /Format jam/)
  assert.throws(() => parseAlarmArgs([], 'wita'), /Format jam/)
})

test('nextAlarmFireMs: hari yang sama bila belum lewat, besok bila sudah', () => {
  // 1 Nov 2026 08:00 WITA = 00:00 UTC
  const morning = Date.UTC(2026, 10, 1, 0, 0, 0)
  assert.equal(nextAlarmFireMs(10, 30, 'wita', morning), Date.UTC(2026, 10, 1, 2, 30, 0), '10:30 WITA hari ini')
  assert.equal(nextAlarmFireMs(7, 0, 'wita', morning), Date.UTC(2026, 10, 1, 23, 0, 0), '07:00 WITA sudah lewat -> besok')
  // 23:00 WITA = 15:00 UTC; alarm WIB 23:30 (= 16:30 UTC) masih hari ini
  const night = Date.UTC(2026, 10, 1, 15, 0, 0)
  assert.equal(nextAlarmFireMs(23, 30, 'wib', night), Date.UTC(2026, 10, 1, 16, 30, 0))
  assert.equal(TZONES.wita.offsetMin, 480)
})

/* ─── Tokenizer pesan petik + flag ───────────────────────────────────────── */

test('tokenizeReminderInput: pesan petik + flag -p/-d di posisi mana pun', () => {
  assert.deepEqual(tokenizeReminderInput('50m "NASINYA HANGUSSS"'),
    { bare: ['50m'], message: 'NASINYA HANGUSSS', dest: 'default' })
  assert.deepEqual(tokenizeReminderInput('50m "NASINYA HANGUSSS" -p'),
    { bare: ['50m'], message: 'NASINYA HANGUSSS', dest: 'private' })
  assert.deepEqual(tokenizeReminderInput('-p 50m "NASINYA HANGUSSS"'),
    { bare: ['50m'], message: 'NASINYA HANGUSSS', dest: 'private' })
  assert.deepEqual(tokenizeReminderInput('10:30 pm wita "BANGUN WOY!" -d'),
    { bare: ['10:30', 'pm', 'wita'], message: 'BANGUN WOY!', dest: 'default' })
  assert.deepEqual(tokenizeReminderInput('50m'),
    { bare: ['50m'], message: null, dest: 'default' }, 'tanpa flag = -d')
  assert.equal(tokenizeReminderInput('50m "  spasi   ganda  "').message, 'spasi ganda', 'spasi dinormalisasi')
})

test('tokenizeReminderInput: semua format invalid ditolak', () => {
  assert.throws(() => tokenizeReminderInput('50m "tak ditutup'), /tidak lengkap/)
  assert.throws(() => tokenizeReminderInput('50m ""'), /tidak boleh kosong/)
  assert.throws(() => tokenizeReminderInput('50m "   "'), /tidak boleh kosong/)
  assert.throws(() => tokenizeReminderInput('50m "halo; dunia"'), /hanya boleh berisi/, 'titik koma di luar whitelist')
  assert.throws(() => tokenizeReminderInput('50m "halo-dunia"'), /hanya boleh berisi/, 'strip di luar whitelist')
  assert.throws(() => tokenizeReminderInput('50m "ada emoji 😀"'), /hanya boleh berisi/)
  assert.throws(() => tokenizeReminderInput('50m "satu" "dua"'), /cukup satu/)
  assert.throws(() => tokenizeReminderInput('50m"nempel"'), /tidak menempel|berdiri sendiri/)
  assert.throws(() => tokenizeReminderInput('50m "nempel"x'), /Sesudah tanda petik penutup/)
  assert.throws(() => tokenizeReminderInput('50m -p -d'), /tidak bisa dipakai bersamaan/)
  assert.throws(() => tokenizeReminderInput('50m -p -p'), /cukup sekali/)
  assert.throws(() => tokenizeReminderInput('50m -x'), /Flag tidak dikenal/)
  assert.throws(() => tokenizeReminderInput('50m "' + 'a'.repeat(201) + '"'), /maksimal 200/)
})

/* ─── Alur plugin timer ──────────────────────────────────────────────────── */

function fakeMsg(over = {}) {
  const replies = []
  const m = {
    chat: '120363@g.us', sender: '628111@s.whatsapp.net', pushName: 'Penguji',
    text: '', fromMe: false, key: { remoteJid: '120363@g.us', id: 'm1' },
    reply: async t => { replies.push(String(t)) },
    ...over,
  }
  m.replies = replies
  return m
}

function pluginCtx(u, over = {}) {
  return { usedPrefix: '.', userData: u, reminderNow: Date.UTC(2026, 10, 1, 0, 0, 0), ...over }
}

test('plugin timer: pasang -> cek -> hapus; deadline kembar + maks 3 ditolak', async () => {
  global.db = { data: { users: {} }, save: async () => {} }
  const u = { timers: [], alarms: [], timezone: '' }
  const T = Date.UTC(2026, 10, 1, 0, 0, 0)

  const m1 = fakeMsg()
  await timerHandler(m1, pluginCtx(u, { command: 'timer', text: '55s', args: ['55s'] }))
  assert.equal(u.timers.length, 1)
  assert.match(m1.replies[0], /Timer dipasang: \*55 detik\*/)

  // 5 detik kemudian pasang 50s -> deadline persis sama -> ditolak
  await assert.rejects(
    () => timerHandler(fakeMsg(), pluginCtx(u, { command: 'timer', text: '50s', args: ['50s'], reminderNow: T + 5000 })),
    e => typeof e === 'string' && /sama persis/.test(e))

  await timerHandler(fakeMsg(), pluginCtx(u, { command: 'timer', text: '30s', args: ['30s'] }))
  await timerHandler(fakeMsg(), pluginCtx(u, { command: 'timer', text: '10s', args: ['10s'] }))
  assert.equal(u.timers.length, 3)
  await assert.rejects(
    () => timerHandler(fakeMsg(), pluginCtx(u, { command: 'timer', text: '40s', args: ['40s'] })),
    e => typeof e === 'string' && /sudah punya 3/.test(e))

  const check = fakeMsg()
  await timerHandler(check, pluginCtx(u, { command: 'timercheck', text: '', args: [] }))
  assert.match(check.replies[0], /1\. 10 detik/, 'daftar urut deadline terdekat')
  assert.match(check.replies[0], /3\. 55 detik/)

  const del = fakeMsg()
  await timerHandler(del, pluginCtx(u, { command: 'timerdelete', text: '1', args: ['1'] }))
  assert.match(del.replies[0], /dihapus/)
  assert.equal(u.timers.length, 2)
  assert.ok(!u.timers.some(t => t.durationMs === 10000), 'yang terhapus timer 10 detik (nomor 1)')
})

/* ─── Alur plugin alarm ──────────────────────────────────────────────────── */

test('plugin alarm: zona eksplisit jadi bawaan; duplikat ditolak; cek + hapus', async () => {
  global.db = { data: { users: {} }, save: async () => {} }
  const u = { timers: [], alarms: [], timezone: '' }
  const T = Date.UTC(2026, 10, 1, 0, 0, 0) // 08:00 WITA

  await assert.rejects(
    () => alarmHandler(fakeMsg(), pluginCtx(u, { command: 'alarm', text: '10:30 pm', args: ['10:30', 'pm'] })),
    e => typeof e === 'string' && /belum tercatat/.test(e), 'tanpa zona & tanpa bawaan ditolak')

  const m1 = fakeMsg()
  await alarmHandler(m1, pluginCtx(u, { command: 'alarm', text: '10:30 pm wita', args: ['10:30', 'pm', 'wita'] }))
  assert.equal(u.timezone, 'wita', 'zona eksplisit tersimpan sebagai bawaan')
  assert.equal(u.alarms.length, 1)
  assert.equal(u.alarms[0].nextFire, Date.UTC(2026, 10, 1, 14, 30, 0), '22:30 WITA hari ini')
  assert.match(m1.replies[0], /Alarm dipasang: \*22:30 WITA\*/)

  await alarmHandler(fakeMsg(), pluginCtx(u, { command: 'alarm', text: '7:00', args: ['7:00'] }))
  assert.equal(u.alarms.length, 2, 'alarm kedua tanpa zona ikut bawaan wita')
  assert.equal(u.alarms[1].tz, 'wita')

  await assert.rejects(
    () => alarmHandler(fakeMsg(), pluginCtx(u, { command: 'alarm', text: '10:30 pm wita', args: ['10:30', 'pm', 'wita'] })),
    e => typeof e === 'string' && /sudah ada/.test(e), 'jam+zona kembar ditolak')

  const check = fakeMsg()
  await alarmHandler(check, pluginCtx(u, { command: 'alarmcheck', text: '', args: [] }))
  assert.match(check.replies[0], /1\. 22:30 WITA/, 'daftar urut bunyi berikutnya (22:30 hari ini < 07:00 besok)')
  assert.match(check.replies[0], /2\. 07:00 WITA/)

  const del = fakeMsg()
  await alarmHandler(del, pluginCtx(u, { command: 'alarmdelete', text: '2', args: ['2'] }))
  assert.match(del.replies[0], /Alarm #2 .* dihapus/)
  assert.equal(u.alarms.length, 1)
})

test('plugin timer/alarm: pesan petik + flag -p tersimpan; pesan invalid ditolak dari plugin', async () => {
  global.db = { data: { users: {} }, save: async () => {} }
  const u = { timers: [], alarms: [], timezone: '' }

  const m1 = fakeMsg()
  await timerHandler(m1, pluginCtx(u, { command: 'timer', text: '50m "NASINYA HANGUSSS" -p', args: [] }))
  assert.equal(u.timers[0].message, 'NASINYA HANGUSSS')
  assert.equal(u.timers[0].dest, 'private')
  assert.match(m1.replies[0], /Pesan: "NASINYA HANGUSSS"/)
  assert.match(m1.replies[0], /chat pribadi kamu/)

  await assert.rejects(
    () => timerHandler(fakeMsg(), pluginCtx(u, { command: 'timer', text: '50m "halo; dunia"', args: [] })),
    e => typeof e === 'string' && /hanya boleh berisi/.test(e))
  assert.equal(u.timers.length, 1, 'yang invalid tidak tersimpan')

  const check = fakeMsg()
  await timerHandler(check, pluginCtx(u, { command: 'timercheck', text: '', args: [] }))
  assert.match(check.replies[0], /"NASINYA HANGUSSS"/)
  assert.match(check.replies[0], /ke chat pribadi/)

  const m2 = fakeMsg()
  await alarmHandler(m2, pluginCtx(u, { command: 'alarm', text: '6:00 am wita "BANGUN WOY" -p', args: [] }))
  assert.equal(u.alarms[0].message, 'BANGUN WOY')
  assert.equal(u.alarms[0].dest, 'private')
})

/* ─── Scheduler ──────────────────────────────────────────────────────────── */

function fakeConn() {
  const sent = []
  return { sent, sendMessage: async (chat, content) => { sent.push({ chat, content }); return { key: { id: 's1' } } } }
}

const BASE = { chat: '120363@g.us', sender: '628111@s.whatsapp.net', name: 'Penguji' }

test('scheduler: timer jatuh tempo bunyi + terhapus; yang belum, diam', async () => {
  const T = Date.UTC(2026, 10, 1, 12, 0, 0)
  const rec = {
    timers: [
      makeTimerItem(BASE, 60000, T - 61000), // deadline T-1s
      makeTimerItem(BASE, 3600000, T), // deadline T+1j
    ],
    alarms: [],
  }
  let saves = 0
  global.db = { data: { users: { '628111@s.whatsapp.net': rec } }, save: async () => { saves++ } }
  const conn = fakeConn()
  const sched = createReminderScheduler({ getConn: () => conn, isOpen: () => true, now: () => T, log: { error: () => {} } })
  sched.start()
  await sched.tick()
  sched.stop()
  assert.equal(conn.sent.length, 1)
  assert.match(conn.sent[0].content.text, /@628111/)
  assert.match(conn.sent[0].content.text, /Timer selesai!/)
  assert.ok(!/Telat/.test(conn.sent[0].content.text), 'telat 1 detik tanpa label telat')
  assert.deepEqual(conn.sent[0].content.mentions, ['628111@s.whatsapp.net'])
  assert.equal(rec.timers.length, 1, 'timer yang belum jatuh tempo tetap ada')
  assert.ok(saves >= 1, 'perubahan tersimpan')
})

test('scheduler: timer kelewat semasa bot mati bunyi dengan label telat', async () => {
  const T = Date.UTC(2026, 10, 1, 12, 0, 0)
  const rec = { timers: [makeTimerItem(BASE, 60000, T - 180000)], alarms: [] } // deadline T-2mnt
  global.db = { data: { users: { k: rec } }, save: async () => {} }
  const conn = fakeConn()
  const sched = createReminderScheduler({ getConn: () => conn, isOpen: () => true, now: () => T, log: { error: () => {} } })
  sched.start()
  await sched.tick()
  sched.stop()
  assert.equal(conn.sent.length, 1)
  assert.match(conn.sent[0].content.text, /Telat 2 menit/)
  assert.equal(rec.timers.length, 0)
})

test('scheduler: alarm bunyi lalu jadwal ulang +24 jam; alarm basi >3 jam dilewati', async () => {
  const T = Date.UTC(2026, 10, 1, 12, 0, 0)
  const alarmDue = { id: 'a1', kind: 'alarm', ...BASE, hour: 19, minute: 55, tz: 'wita', nextFire: T - 5 * 60000 }
  const alarmStale = { id: 'a2', kind: 'alarm', ...BASE, hour: 8, minute: 0, tz: 'wita', nextFire: T - 4 * 3600000 }
  const rec = { timers: [], alarms: [alarmDue, alarmStale] }
  global.db = { data: { users: { k: rec } }, save: async () => {} }
  const conn = fakeConn()
  const sched = createReminderScheduler({ getConn: () => conn, isOpen: () => true, now: () => T, log: { error: () => {} } })
  sched.start()
  await sched.tick()
  sched.stop()
  assert.equal(conn.sent.length, 1, 'hanya alarm yang telat 5 menit yang bunyi')
  assert.match(conn.sent[0].content.text, /Alarm 19:55 WITA/)
  assert.equal(alarmDue.nextFire, nextAlarmFireMs(19, 55, 'wita', T), 'alarm harian terjadwal ulang')
  assert.ok(alarmStale.nextFire > T, 'alarm basi lompat ke kejadian berikutnya tanpa bunyi')
})

test('scheduler: pesan kustom tampil + footer penanda; -p bunyi ke DM tanpa tag', async () => {
  const T = Date.UTC(2026, 10, 1, 12, 0, 0)
  const grupItem = makeTimerItem(BASE, 60000, T - 61000, { message: 'NASINYA HANGUSSS' })
  const dmItem = makeAlarmItem(BASE, { hour: 19, minute: 55, tzKey: 'wita' }, T - 3600000, { message: 'BANGUN WOY', dest: 'private' })
  dmItem.nextFire = T - 60000
  const rec = { timers: [grupItem], alarms: [dmItem] }
  global.db = { data: { users: { k: rec } }, save: async () => {} }
  const conn = fakeConn()
  const sched = createReminderScheduler({ getConn: () => conn, isOpen: () => true, now: () => T, log: { error: () => {} } })
  sched.start()
  await sched.tick()
  sched.stop()
  assert.equal(conn.sent.length, 2)
  const keGrup = conn.sent.find(s => s.chat === BASE.chat)
  assert.match(keGrup.content.text, /@628111 ⏰ \*Timer selesai!\*/)
  assert.match(keGrup.content.text, /NASINYA HANGUSSS/)
  assert.match(keGrup.content.text, /— Timer 1 menit yang dipasang pukul/, 'footer penanda timer yang pernah di-set')
  const keDm = conn.sent.find(s => s.chat === BASE.sender)
  assert.ok(keDm, 'alarm -p dikirim ke DM pemasang')
  assert.match(keDm.content.text, /BANGUN WOY/)
  assert.match(keDm.content.text, /— Alarm harian 19:55 WITA yang kamu pasang/)
  assert.ok(!keDm.content.text.startsWith('@'), 'di DM tidak ada tag')
  assert.deepEqual(keDm.content.mentions, [])
})

test('scheduler: koneksi belum open -> tidak ada yang bunyi, data utuh', async () => {
  const T = Date.UTC(2026, 10, 1, 12, 0, 0)
  const rec = { timers: [makeTimerItem(BASE, 60000, T - 61000)], alarms: [] }
  global.db = { data: { users: { k: rec } }, save: async () => {} }
  const conn = fakeConn()
  const sched = createReminderScheduler({ getConn: () => conn, isOpen: () => false, now: () => T, log: { error: () => {} } })
  sched.start()
  await sched.tick()
  sched.stop()
  assert.equal(conn.sent.length, 0)
  assert.equal(rec.timers.length, 1)
})
