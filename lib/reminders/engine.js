// lib/reminders/engine.js
//
// Mesin bersama keluarga plugin pengingat (.timer + .alarm) — perintah
// Veo 2026-11-01. Dua plugin berbagi inti yang sama persis (aturan
// arsitektur §12 kategori engine bersama): penguraian durasi & jam,
// matematika zona waktu Indonesia, penyimpanan di record users
// (field timers/alarms/timezone), dan satu scheduler timestamp yang
// membunyikan pengingat yang jatuh tempo.
//
// Kenapa bukan node-cron: timer adalah deadline sekali-jalan, bukan
// pola berulang; cron memaksa satu job per timer plus lapisan
// persistensi sendiri untuk rehidrasi sesudah restart. Di sini semua
// pengingat adalah timestamp absolut yang persisten di database,
// scheduler hanya mengarahkan satu timeout ke deadline terdekat
// (ditambah bangun pengaman berkala), jadi restart bot tidak
// menghilangkan jadwal: yang kelewat semasa bot mati dibunyikan
// telat saat bot hidup lagi (alarm: hanya bila telat <= 3 jam,
// selebihnya lompat ke hari berikutnya).

export const MAX_TIMERS_PER_USER = 3
export const MAX_ALARMS_PER_USER = 3
export const MIN_TIMER_MS = 1000
export const MAX_TIMER_MS = 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const WAKE_CAP_MS = 30 * 1000 // jeda maksimum antar-bangun scheduler
const RETRY_AFTER_FAIL_MS = 30 * 1000
export const ALARM_LATE_SKIP_MS = 3 * 60 * 60 * 1000
export const LATE_LABEL_MS = 60 * 1000

// Zona waktu Indonesia: offset tetap (tidak ada DST), jadi matematika
// jam dinding cukup dengan geser offset — Intl hanya untuk tampilan.
export const TZONES = {
  wib: { key: 'wib', label: 'WIB', iana: 'Asia/Jakarta', offsetMin: 7 * 60 },
  wita: { key: 'wita', label: 'WITA', iana: 'Asia/Makassar', offsetMin: 8 * 60 },
  wit: { key: 'wit', label: 'WIT', iana: 'Asia/Jayapura', offsetMin: 9 * 60 },
}
const IANA_LABEL = { 'Asia/Jakarta': 'WIB', 'Asia/Makassar': 'WITA', 'Asia/Jayapura': 'WIT' }

/* ─── Format ─────────────────────────────────────────────────────────────── */

export function formatDuration(ms) {
  const totalSec = Math.max(0, Math.round(Number(ms) / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const parts = []
  if (h) parts.push(`${h} jam`)
  if (m) parts.push(`${m} menit`)
  if (s || !parts.length) parts.push(`${s} detik`)
  return parts.join(' ')
}

const pad2 = n => String(n).padStart(2, '0')
export const formatHHMM = (hour, minute) => `${pad2(hour)}:${pad2(minute)}`

function intlFmt(locale, options, timeZone) {
  try { return new Intl.DateTimeFormat(locale, { timeZone, ...options }) }
  catch { return new Intl.DateTimeFormat('en-GB', { timeZone, ...options }) }
}

// "Senin, 2 November 2026 pukul 22:30" di zona waktu alarm itu sendiri.
export function formatFireDate(ms, tzKey) {
  const tz = TZONES[tzKey] ?? TZONES.wita
  const date = intlFmt('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, tz.iana).format(new Date(ms))
  const clock = intlFmt('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }, tz.iana).format(new Date(ms))
  return `${date} pukul ${clock} ${tz.label}`
}

// Jam dinding sebuah timestamp di zona bot (untuk konfirmasi timer).
export function formatClockWithTz(ms, iana = 'Asia/Jakarta') {
  const clock = intlFmt('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }, iana).format(new Date(ms))
  return `${clock} ${IANA_LABEL[iana] ?? iana}`
}

/* ─── Penguraian timer ───────────────────────────────────────────────────── */

// Tata bahasa durasi (perintah Veo): segmen angka+satauan s/m/h,
// satuan boleh menempel atau berjarak, segmen tanpa satuan = menit.
// "50" / "50s" / "50 s" / "1h 30" / "23h59m59s" / "23h 59m 59s".
export function parseDurationMs(text) {
  const s = String(text ?? '').trim().toLowerCase()
  if (!s) throw new Error('Durasinya belum diisi.')
  if (!/^(\d+\s*[smh]?\s*)+$/.test(s)) throw new Error('Format durasi tidak dikenal. Pakai angka + s/m/h, mis. 50s, 15m, 1h30m, 23h59m59s.')
  let total = 0
  for (const m of s.matchAll(/(\d+)\s*([smh])?/g)) {
    const mult = m[2] === 'h' ? 3600000 : m[2] === 's' ? 1000 : 60000
    total += Number(m[1]) * mult
  }
  if (total < MIN_TIMER_MS) throw new Error('Durasi minimal 1 detik.')
  if (total > MAX_TIMER_MS) throw new Error('Durasi maksimal 24 jam.')
  return total
}

/* ─── Penguraian alarm ───────────────────────────────────────────────────── */

// args: ["10:30", "pm", "wita"] — jam wajib pertama; am/pm dan zona
// (wib/wita/wit) bebas urutan sesudahnya. Jam 1–12 + am/pm dikonversi;
// jam di luar itu dianggap format 24 jam dan am/pm gugur (12:00 =
// siang). Zona kosong jatuh ke userTimezone; tetap kosong -> tzKey
// null (plugin yang memutuskan pesan penolakannya).
export function parseAlarmArgs(args, userTimezone = '') {
  const tokens = (args ?? []).map(t => String(t).toLowerCase()).filter(Boolean)
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(tokens[0] ?? '')
  if (!timeMatch) throw new Error('Format jam tidak dikenal. Pakai HH:MM, mis. 10:30 pm wita atau 22:30.')
  let hour = Number(timeMatch[1])
  const minute = Number(timeMatch[2])
  if (hour > 23 || minute > 59) throw new Error('Jam/menit di luar rentang (00:00–23:59).')
  let ampm = null
  let tzKey = null
  for (const tok of tokens.slice(1)) {
    if (tok === 'am' || tok === 'pm') {
      if (ampm) throw new Error('am/pm cukup sekali saja.')
      ampm = tok
    } else if (TZONES[tok]) {
      if (tzKey) throw new Error('Zona waktu cukup sekali saja.')
      tzKey = tok
    } else {
      throw new Error(`Token tidak dikenal: "${tok}". Yang dikenal: am, pm, wib, wita, wit.`)
    }
  }
  if (ampm && hour >= 1 && hour <= 12) hour = ampm === 'pm' ? (hour % 12) + 12 : hour % 12
  const explicitTz = !!tzKey
  if (!tzKey && userTimezone && TZONES[userTimezone]) tzKey = userTimezone
  return { hour, minute, tzKey, explicitTz }
}

// Timestamp bunyi berikutnya untuk alarm harian pada jam dinding
// hour:minute di zona tzKey, dihitung dari nowMs. Kandidat yang
// sudah lewat (termasuk tepat sekarang) bergeser ke hari berikutnya.
export function nextAlarmFireMs(hour, minute, tzKey, nowMs) {
  const offset = (TZONES[tzKey] ?? TZONES.wita).offsetMin * 60000
  const wall = new Date(nowMs + offset)
  let candidate = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), hour, minute, 0) - offset
  if (candidate <= nowMs) candidate += DAY_MS
  return candidate
}

/* ─── Tokenizer masukan: pesan petik + flag tujuan ───────────────────────── */

// Perintah Veo 2026-11-02: pesan bebas dalam tanda petik dua
// (.timer 50m "NASINYA HANGUSSS") dan flag tujuan bunyi: -p = chat
// pribadi pemasang, -d = chat tempat memasang (bawaan tanpa flag).
// Validasi SENGAJA ketat, tanpa celah: petik wajib sepasang dan
// berdiri sendiri (tidak menempel kata lain), isi wajib ada (bukan
// spasi), dan isi hanya boleh huruf/angka/spasi/titik/koma/tanda
// tanya/tanda seru. Semua penyimpangan ditolak dengan pesan jelas.
export const MESSAGE_MAX_LEN = 200
const MESSAGE_CHARS = /^[A-Za-z0-9 .,?! ]*$/

export function tokenizeReminderInput(text) {
  const s = String(text ?? '')
  const bare = []
  let message = null
  let dest = 'default'
  let destSeen = null
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (i >= s.length) break
    if (s[i] === '"') {
      const close = s.indexOf('"', i + 1)
      if (close === -1) throw new Error('Tanda petik tidak lengkap: pesan harus ditutup tanda petik.')
      if (close + 1 < s.length && !/\s/.test(s[close + 1])) throw new Error('Sesudah tanda petik penutup harus ada spasi atau akhir perintah.')
      if (message !== null) throw new Error('Pesan dalam tanda petik cukup satu.')
      const raw = s.slice(i + 1, close)
      if (!MESSAGE_CHARS.test(raw)) throw new Error('Pesan hanya boleh berisi huruf, angka, spasi, titik, koma, tanda tanya, dan tanda seru.')
      const value = raw.trim().replace(/ +/g, ' ')
      if (!value) throw new Error('Pesan dalam tanda petik tidak boleh kosong.')
      if (value.length > MESSAGE_MAX_LEN) throw new Error(`Pesan maksimal ${MESSAGE_MAX_LEN} karakter.`)
      message = value
      i = close + 1
      continue
    }
    let j = i
    while (j < s.length && !/\s/.test(s[j])) j++
    const token = s.slice(i, j)
    if (token.includes('"')) throw new Error('Tanda petik harus berdiri sendiri memisahkan pesan, tidak menempel pada kata lain.')
    const lower = token.toLowerCase()
    if (lower === '-p' || lower === '-d') {
      const d = lower === '-p' ? 'private' : 'default'
      if (destSeen === d) throw new Error(`Flag ${lower} cukup sekali saja.`)
      if (destSeen) throw new Error('Flag -p dan -d tidak bisa dipakai bersamaan.')
      destSeen = d
      dest = d
    } else if (token.startsWith('-')) {
      throw new Error(`Flag tidak dikenal: "${token}". Yang dikenal: -p (bunyi ke chat pribadi) dan -d (bunyi di chat ini).`)
    } else {
      bare.push(token)
    }
    i = j
  }
  return { bare, message, dest }
}

/* ─── Item + gerbang slot ────────────────────────────────────────────────── */

let idCounter = 0
const newId = nowMs => `${nowMs.toString(36)}${(idCounter = (idCounter + 1) % 46656).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export function makeTimerItem({ chat, sender, name }, durationMs, nowMs, { message = null, dest = 'default' } = {}) {
  return { id: newId(nowMs), kind: 'timer', chat, sender, name: name ?? '', createdAt: nowMs, deadline: nowMs + durationMs, durationMs, message, dest }
}

export function makeAlarmItem({ chat, sender, name }, { hour, minute, tzKey }, nowMs, { message = null, dest = 'default' } = {}) {
  return { id: newId(nowMs), kind: 'alarm', chat, sender, name: name ?? '', createdAt: nowMs, hour, minute, tz: tzKey, nextFire: nextAlarmFireMs(hour, minute, tzKey, nowMs), message, dest }
}

export const sortedTimers = record => [...(Array.isArray(record?.timers) ? record.timers : [])].sort((a, b) => a.deadline - b.deadline)
export const sortedAlarms = record => [...(Array.isArray(record?.alarms) ? record.alarms : [])].sort((a, b) => a.nextFire - b.nextFire)

// Deadline yang sama persis (ketepatan detik) dengan timer lain
// milik pengguna yang sama ditolak — perintah Veo.
export function assertTimerSlot(record, deadlineMs) {
  const timers = Array.isArray(record?.timers) ? record.timers : []
  if (timers.length >= MAX_TIMERS_PER_USER) throw new Error(`Kamu sudah punya ${MAX_TIMERS_PER_USER} timer aktif (maksimal). Hapus dulu dengan timerdelete.`)
  const clash = timers.find(t => Math.floor(t.deadline / 1000) === Math.floor(deadlineMs / 1000))
  if (clash) throw new Error(`Deadline itu sama persis dengan timermu yang lain (${formatDuration(clash.durationMs)}). Geser sedikit durasinya.`)
}

export function assertAlarmSlot(record, { hour, minute, tzKey }) {
  const alarms = Array.isArray(record?.alarms) ? record.alarms : []
  if (alarms.length >= MAX_ALARMS_PER_USER) throw new Error(`Kamu sudah punya ${MAX_ALARMS_PER_USER} alarm aktif (maksimal). Hapus dulu dengan alarmdelete.`)
  const clash = alarms.find(a => a.hour === hour && a.minute === minute && a.tz === tzKey)
  if (clash) throw new Error(`Alarm ${formatHHMM(hour, minute)} ${(TZONES[tzKey]?.label ?? tzKey)} sudah ada.`)
}

/* ─── Scheduler ──────────────────────────────────────────────────────────── */

export function createReminderScheduler({ getConn, isOpen, now = () => Date.now(), log = console } = {}) {
  let running = false
  let handle = null
  let firing = false
  const retryNotBefore = new Map()

  function listReminders() {
    const users = global.db?.data?.users ?? {}
    const out = []
    for (const record of Object.values(users)) {
      if (!record || typeof record !== 'object') continue
      if (Array.isArray(record.timers)) for (const item of record.timers) out.push({ record, item, fireAt: item.deadline })
      if (Array.isArray(record.alarms)) for (const item of record.alarms) out.push({ record, item, fireAt: item.nextFire })
    }
    return out
  }

  function arm() {
    if (!running) return
    clearTimeout(handle)
    let delay = WAKE_CAP_MS
    const items = listReminders()
    if (items.length) {
      const next = Math.min(...items.map(i => i.fireAt))
      delay = Math.max(0, Math.min(next - now(), WAKE_CAP_MS))
    }
    handle = setTimeout(() => { tick().catch(e => log.error?.('[reminders] tick gagal:', e)) }, delay)
    handle.unref?.()
  }

  // Tujuan bunyi: item.dest 'private' (-p) -> DM pemasang; selain
  // itu chat asal. Tag @ hanya di grup (di DM tidak perlu).
  async function deliver(conn, item, buildText) {
    const target = item.dest === 'private' ? item.sender : item.chat
    let mentionId = null
    let digits = ''
    if (String(target).endsWith('@g.us')) {
      mentionId = item.sender
      try {
        const resolved = await conn.identity?.forAction?.([item.sender], 'mention', {})
        if (Array.isArray(resolved) && resolved[0]) mentionId = resolved[0]
      } catch { /* bentuk tersimpan tetap dipakai */ }
      digits = String(mentionId ?? '').replace(/[^0-9]/g, '')
    }
    await conn.sendMessage(target, { text: buildText(digits), mentions: mentionId ? [mentionId] : [] })
  }

  const mentionPrefix = digits => digits ? `@${digits} ` : ''
  const botTz = () => global.timezone ?? 'Asia/Jakarta'
  const timerText = (item, lateMs) => digits => {
    const lines = [`${mentionPrefix(digits)}⏰ *Timer selesai!*`]
    lines.push(item.message ? item.message : `Timer ${formatDuration(item.durationMs)} yang kamu pasang sudah habis.`)
    lines.push(`_— Timer ${formatDuration(item.durationMs)} yang dipasang pukul ${formatClockWithTz(item.createdAt, botTz())}_`)
    if (lateMs > LATE_LABEL_MS) lines.push(`_Telat ${formatDuration(lateMs)} dari jadwal — bot sempat tidak aktif._`)
    return lines.join('\n')
  }
  const alarmText = (item, lateMs) => digits => {
    const clock = `${formatHHMM(item.hour, item.minute)} ${(TZONES[item.tz]?.label ?? item.tz)}`
    const lines = [`${mentionPrefix(digits)}🔔 *Alarm ${clock}!*`]
    if (item.message) lines.push(item.message)
    lines.push(`_— Alarm harian ${clock} yang kamu pasang_`)
    if (lateMs > LATE_LABEL_MS) lines.push(`_Telat ${formatDuration(lateMs)} dari jadwal — bot sempat tidak aktif._`)
    return lines.join('\n')
  }

  async function tick() {
    if (!running || firing) return
    firing = true
    try {
      const nowMs = now()
      const conn = getConn?.()
      if (!conn || !isOpen?.()) return // belum tersambung; arm() di finally menjadwalkan cek ulang
      const due = listReminders().filter(x => x.fireAt <= nowMs && (retryNotBefore.get(x.item.id) ?? 0) <= nowMs)
      let changed = false
      for (const { record, item } of due) {
        try {
          if (item.kind === 'alarm') {
            const lateMs = nowMs - item.nextFire
            if (lateMs > ALARM_LATE_SKIP_MS) {
              // Kelewat terlalu lama semasa bot mati: jangan bunyikan
              // alarm basi, lompat ke kejadian berikutnya.
              item.nextFire = nextAlarmFireMs(item.hour, item.minute, item.tz, nowMs)
              changed = true
              continue
            }
            await deliver(conn, item, alarmText(item, lateMs))
            item.nextFire = nextAlarmFireMs(item.hour, item.minute, item.tz, nowMs)
            changed = true
          } else {
            await deliver(conn, item, timerText(item, nowMs - item.deadline))
            if (Array.isArray(record.timers)) record.timers = record.timers.filter(t => t.id !== item.id)
            changed = true
          }
          retryNotBefore.delete(item.id)
        } catch (e) {
          log.error?.('[reminders] gagal membunyikan pengingat:', e)
          retryNotBefore.set(item.id, now() + RETRY_AFTER_FAIL_MS)
        }
      }
      if (changed) {
        try { await global.db?.save?.('users') } catch (e) { log.error?.('[reminders] simpan users gagal:', e) }
      }
    } finally {
      firing = false
      arm()
    }
  }

  return {
    start() { if (running) return; running = true; arm() },
    stop() { running = false; clearTimeout(handle) },
    poke() { arm() },
    tick,
    get running() { return running },
  }
}

// Singleton proses: runtime yang memiliki getConn/isOpen, plugin
// cukup memanggil pokeReminders() sesudah mengubah data.
let activeScheduler = null
export function startReminderScheduler(deps) {
  activeScheduler ??= createReminderScheduler(deps)
  activeScheduler.start()
  return activeScheduler
}
export function stopReminderScheduler() { activeScheduler?.stop() }
export function pokeReminders() { activeScheduler?.poke() }
