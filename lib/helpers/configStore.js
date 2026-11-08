import { validatePrefix } from './config.js'

// Penyimpanan override konfigurasi runtime (diatur founder lewat perintah .config).
// Nilai dasar tetap di config.js; override tersimpan sebagai record 'global' pada
// collection 'config' (databases/config.json) dan diterapkan ke globalThis secara
// in-place — objek global.bots tidak diganti, hanya field-nya, supaya pemegang
// referensi lama (mis. SubBotManager) ikut merasakan perubahan tanpa restart.
// Kunci identitas & rahasia (founder/owner/mods/pairing/nomorbot/APIs/APIKeys)
// SENGAJA tidak terdaftar di sini: tidak dikelola dari chat.

export const CONFIG_REGISTRY = {
  'logPrivacy': { type: 'enum', values: ['masked', 'full'], desc: 'masked = isi pesan & pengirim disamarkan di log terminal; full = tampil utuh' },
  'kdriveMode': { type: 'enum', values: ['direct', 'stranger'], desc: 'Engine kDrive: direct = bot request langsung ke kuramadrive (perlu jaringan ter-whitelist); stranger = server asing, bot tidak request ke kuramadrive — .unduh hanya menerima URL endpoint langsung hasil resolusi pihak ter-whitelist' },
  'kdrivePeer': { type: 'string', minLength: 0, maxLength: 25, desc: 'Nomor bot pasangan relay kDrive (digit saja, cth 62812...): bagi mode stranger = alamat bot resolver yang dimintai resolusi; bagi bot resolver = satu-satunya nomor yang boleh meminta resolusi' },
  'namebot': { type: 'string', minLength: 1, maxLength: 50, desc: 'Nama tampilan bot' },
  'timezone': { type: 'timezone', desc: 'Zona waktu bot, mis. Asia/Jakarta' },
  'prefix': { type: 'prefix', desc: 'Karakter prefix perintah' },
  'defaultLimit': { type: 'int', min: 0, max: 100000, desc: 'Limit harian bawaan pengguna' },
  'cooldownMs': { type: 'int', min: 0, max: 60000, desc: 'Jeda minimum antar perintah (ms)' },
  'maxMessageAgeSec': { type: 'int', min: 0, max: 86400, desc: 'Umur maksimum pesan yang diproses (detik)' },
  'markOnline': { type: 'bool', desc: 'Tandai bot online saat terhubung' },
  'hotReloadCore': { type: 'bool', desc: 'Hot-reload handler.js inti (berlaku setelah restart)' },
  'bridge': { type: 'bool', desc: 'Saklar jembatan lokal Ryn: perintah dari file di src/private/bridge (mode say/cmd), target terkunci room owner, balasan disalin ke outbox untuk audit' },
  'rynScope': { type: 'enum', values: ['private', 'group', 'both'], desc: 'Jangkauan fitur chat Ryn (.ryn, trigger nama, mode percakapan): private = DM founder saja; group = grup saja; both = keduanya' },
  'rynUsers': { type: 'enum', values: ['founder', 'anyone'], desc: 'Siapa yang boleh memanggil Ryn DI GRUP: founder = hanya founder; anyone = semua anggota grup yang diizinkan (rynScope/rynGroups). DM selalu founder-only.' },
  'rynGroups': { type: 'jidlist', desc: 'Daftar JID grup yang boleh memakai chat Ryn (pisahkan koma, cth 120363xxx@g.us). Kosong = semua grup.' },
  'rynTriggerReply': { type: 'bool', desc: 'Trigger chat Ryn: pesan bebas yang me-reply pesan bot dianggap memanggil Ryn (sekali jalan). Mati = hanya .ryn, panggilan nama, dan sesi.' },
  'rynTriggerMention': { type: 'bool', desc: 'Trigger chat Ryn: pesan bebas yang men-tag/men-mention bot dianggap memanggil Ryn (sekali jalan).' },
  'botChannel': { type: 'newsletter', desc: 'JID saluran WhatsApp tujuan broadcast .bcc (format: 120363xxx@newsletter). Kosong = belum diatur, .bcc menolak sampai diatur.' },
  'wait': { type: 'string', minLength: 0, maxLength: 200, desc: 'Teks tunggu bawaan' },
  'eror': { type: 'string', minLength: 0, maxLength: 200, desc: 'Teks error bawaan' },
  'bots.enabled': { type: 'bool', desc: 'Saklar utama fitur jadibot (selain toggle .setting jadibot per bot)' },
  'bots.allowCustomPlugins': { type: 'pluginPolicy', desc: 'Plugin kustom sub-bot: false | true | owner-approval' },
  'bots.maxBots': { type: 'int', min: 0, max: 50, desc: 'Maksimum sub-bot yang tercatat' },
  'bots.maxPerUser': { type: 'int', min: 0, max: 10, desc: 'Maksimum sub-bot per pengguna' },
  'bots.pairingTimeoutSec': { type: 'int', min: 10, max: 600, desc: 'Batas waktu pairing sub-bot (detik)' },
  'bots.heapMB': { type: 'int', min: 64, max: 4096, desc: 'Batas heap worker sub-bot (MB, berlaku untuk sub-bot baru)' },
  'bots.spawnStaggerSec': { type: 'int', min: 0, max: 60, desc: 'Jeda antar spawn sub-bot saat restore (detik)' },
  'bots.maxPlugins': { type: 'int', min: 0, max: 500, desc: 'Maksimum plugin kustom per sub-bot' },
  'bots.maxPluginKB': { type: 'int', min: 1, max: 1024, desc: 'Ukuran maksimum plugin kustom sub-bot (KB)' },
  'bots.maxDiskMB': { type: 'int', min: 10, max: 10000, desc: 'Maksimum pemakaian disk sandbox sub-bot (MB)' },
  'bots.allowedPackages': { type: 'list', desc: 'Paket npm yang boleh diimpor plugin kustom sub-bot (pisahkan koma)' },
  'anime.users': { type: 'userlist', desc: 'Whitelist user fitur anime: nomor/JID/LID yang boleh memakai .ongoing/.carianime/.anime/.pilih (pisahkan koma). Founder/owner selalu boleh. Kosong = tidak ada user biasa yang boleh.' },
  'anime.groups': { type: 'jidlist', desc: 'Grup yang boleh memakai fitur anime (pisahkan koma, cth 120363xxx@g.us). Kosong = fitur anime tutup di semua grup; DM tetap mengikuti anime.users.' },
  'bigsend.mode': { type: 'enum', values: ['off', 'founder', 'all'], desc: 'Mode Penjaga Kirim Besar (kirim file > 150 MB): off = mati, founder = hanya perintah founder (bawaan), all = non-founder juga boleh sampai plafonnya saat server sunyi. Juga berfungsi sebagai kill switch.' },
  'bigsend.founderCapMB': { type: 'int', min: 150, max: 1024, desc: 'Plafon kirim besar untuk perintah founder (MB, bawaan 1024). Batas keras di kode tetap 1024.' },
  'bigsend.userCapMB': { type: 'int', min: 150, max: 500, desc: 'Plafon kirim besar untuk non-founder (MB, bawaan 500). Batas keras di kode tetap 500.' },
  'bigsend.founderWaitMin': { type: 'int', min: 0, max: 10, desc: 'Batas tunggu reservasi kirim besar founder (menit, bawaan 3) sebelum dinyatakan tidak dikirim.' },
  'bigsend.userWaitMin': { type: 'int', min: 0, max: 30, desc: 'Batas tunggu reservasi kirim besar non-founder (menit, bawaan 10) sebelum jatuh ke info + link.' },
  'bigsend.commitCapMB': { type: 'int', min: 512, max: 8192, desc: 'Plafon komitmen RAM Penjaga Kirim Besar (MB, bawaan 3500): RSS/buku besar + klaim baru tidak boleh melewati ini.' },
  'bigsend.osReserveMB': { type: 'int', min: 32, max: 2048, desc: 'Lantai absolut MemAvailable OS (MB, bawaan 128): kirim besar ditahan hanya bila sisa memori sesudah klaim di bawah lantai ini (rem darurat host sekarat). Bukan cadangan besar — tekanan nyata dijaga bigsend.pressureMaxPct, karena MemAvailable mentah menyesatkan di VM ber-balloon.' },
  'bigsend.pressureMaxPct': { type: 'int', min: 1, max: 50, desc: 'Ambang tekanan memori PSI (some avg10, persen, bawaan 5): di atas ini kirim besar menunggu — kernel benar-benar tersendat menunggu reclaim. Bermakna sama di semua host, kebal artefak balloon.' },
}
// Kategori tampilan .config list (perintah pemilik 2026-11-08): kunci
// dikelompokkan menurut fitur yang memakainya, supaya daftar panjangnya
// terbaca per wilayah dan semua kunci satu fitur terlihat sekaligus
// (biang bingungnya dulu: kunci jadibot tersebar di deret alfabet).
// Klasifikasi murni presentasi — tidak mengubah nilai, penyimpanan,
// atau validasi. Prefix namespace (bots./bigsend./anime.) menentukan
// kategori; kunci tanpa prefix dipetakan eksplisit di CATEGORY_BY_KEY;
// sisanya Umum.
export const CONFIG_CATEGORIES = [
  { id: 'umum', label: 'Umum', aliases: ['umum', 'general'] },
  { id: 'jadibot', label: 'Jadibot (Sub-Bot)', aliases: ['jadibot', 'bots', 'subbot', 'sub-bot'] },
  { id: 'bigsend', label: 'Penjaga Kirim Besar', aliases: ['bigsend', 'penjaga', 'kirim-besar'] },
  { id: 'anime', label: 'Anime (Kuramanime)', aliases: ['anime', 'kuramanime'] },
  { id: 'kdrive', label: 'kDrive', aliases: ['kdrive'] },
  { id: 'ryn', label: 'Ryn — Jembatan & Chat', aliases: ['ryn', 'bridge', 'jembatan'] },
]
const CATEGORY_BY_PREFIX = { bots: 'jadibot', bigsend: 'bigsend', anime: 'anime' }
const CATEGORY_BY_KEY = {
  kdriveMode: 'kdrive', kdrivePeer: 'kdrive',
  bridge: 'ryn', rynScope: 'ryn', rynUsers: 'ryn', rynGroups: 'ryn', rynTriggerReply: 'ryn', rynTriggerMention: 'ryn',
}
export function configCategoryOf(key) {
  return CATEGORY_BY_PREFIX[String(key).split('.')[0]] ?? CATEGORY_BY_KEY[key] ?? 'umum'
}
export function resolveConfigCategory(text) {
  const q = String(text ?? '').trim().toLowerCase()
  if (!q) return null
  return CONFIG_CATEGORIES.find(c => c.aliases.includes(q))?.id ?? null
}
export function groupConfigRows(rows) {
  return CONFIG_CATEGORIES
    .map(c => ({ id: c.id, label: c.label, rows: rows.filter(r => r.category === c.id) }))
    .filter(g => g.rows.length)
}

const UNSAFE = new Set(['__proto__', 'prototype', 'constructor'])
const RECORD_KEY = 'global'
let defaultsSnapshot = null

function getPath(obj, dotted) { return dotted.split('.').reduce((o, k) => (o !== null && typeof o === 'object' ? o[k] : undefined), obj) }
function setPath(obj, dotted, value) {
  const parts = dotted.split('.')
  let target = obj
  for (const part of parts.slice(0, -1)) { if (UNSAFE.has(part)) throw new Error('Kunci config tidak aman'); if (target[part] === null || typeof target[part] !== 'object') target[part] = {}; target = target[part] }
  const last = parts.at(-1)
  if (UNSAFE.has(last)) throw new Error('Kunci config tidak aman')
  if (value === undefined) delete target[last]; else target[last] = value
}
function descriptor(key) { const d = CONFIG_REGISTRY[key]; if (!d) throw new Error(`Kunci config tidak dikenal: ${key}. Lihat .config list`); return d }

export function coerceConfigValue(key, raw) {
  const d = descriptor(key)
  if (typeof raw !== 'string') throw new Error('Nilai harus teks')
  const text = raw.trim()
  switch (d.type) {
    case 'bool': {
      if (/^(on|true|1|ya)$/i.test(text)) return true
      if (/^(off|false|0|tidak)$/i.test(text)) return false
      throw new Error(`${key} butuh nilai boolean: on/off`)
    }
    case 'int': {
      if (!/^-?\d+$/.test(text)) throw new Error(`${key} butuh bilangan bulat`)
      const n = Number(text)
      if (n < d.min || n > d.max) throw new Error(`${key} harus antara ${d.min}–${d.max}`)
      return n
    }
    case 'enum': {
      const v = d.values.find(x => x.toLowerCase() === text.toLowerCase())
      if (v === undefined) throw new Error(`${key} harus salah satu: ${d.values.join(' | ')}`)
      return v
    }
    case 'pluginPolicy': {
      if (/^false$/i.test(text)) return false
      if (/^true$/i.test(text)) return true
      if (/^owner-approval$/i.test(text)) return 'owner-approval'
      throw new Error(`${key} harus salah satu: false | true | owner-approval`)
    }
    case 'string': {
      if (text.length < d.minLength || text.length > d.maxLength) throw new Error(`${key} harus ${d.minLength}–${d.maxLength} karakter`)
      return text
    }
    case 'timezone': {
      try { new Intl.DateTimeFormat('en-US', { timeZone: text }) } catch { throw new Error(`Zona waktu tidak dikenal: ${text}`) }
      return text
    }
    case 'prefix': return validatePrefix(text)
    case 'list': {
      const items = text.split(',').map(s => s.trim()).filter(Boolean)
      if (items.length > 50) throw new Error('Maksimum 50 paket')
      for (const item of items) if (!/^@?[a-z0-9][a-z0-9._/-]*$/i.test(item) || item.length > 214) throw new Error(`Nama paket tidak valid: ${item}`)
      return items
    }
    case 'userlist': {
      const items = text.split(',').map(s => s.trim()).filter(Boolean)
      if (items.length > 50) throw new Error('Maksimum 50 user')
      for (const item of items) if (!/^\d{7,15}(@s\.whatsapp\.net|@lid)?$/.test(item)) throw new Error(`User tidak valid: ${item} (nomor digit saja, JID 628xxx@s.whatsapp.net, atau LID 123xxx@lid)`)
      return items
    }
    case 'jidlist': {
      const items = text.split(',').map(s => s.trim()).filter(Boolean)
      if (items.length > 50) throw new Error('Maksimum 50 grup')
      for (const item of items) if (!/^[0-9]+(-[0-9]+)?@g\.us$/.test(item)) throw new Error(`JID grup tidak valid: ${item} (format: 120363xxx@g.us)`)
      return items
    }
    case 'newsletter': {
      if (!/^[0-9]+@newsletter$/.test(text)) throw new Error(`${key} harus JID saluran: 120363xxx@newsletter`)
      return text
    }
    default: throw new Error(`Tipe config tidak dikenal untuk ${key}`)
  }
}

export function formatConfigValue(value) {
  if (value === undefined) return '(tidak diset)'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(kosong)'
  return String(value)
}

export function configRecord(db) { return db.ensure('config', RECORD_KEY) }
export function captureConfigDefaults(source = globalThis) {
  defaultsSnapshot = {}
  for (const key of Object.keys(CONFIG_REGISTRY)) { const v = getPath(source, key); defaultsSnapshot[key] = v === undefined ? undefined : structuredClone(v) }
  return defaultsSnapshot
}
export function applyStoredConfig(db, target = globalThis) {
  if (!defaultsSnapshot) captureConfigDefaults(target)
  const record = configRecord(db), applied = []
  for (const key of Object.keys(CONFIG_REGISTRY)) {
    const stored = getPath(record, key)
    if (stored !== undefined) { setPath(target, key, structuredClone(stored)); applied.push(key) }
  }
  return applied
}
export function listConfig(db, target = globalThis) {
  const record = configRecord(db)
  return Object.keys(CONFIG_REGISTRY).sort().map(key => ({ key, desc: CONFIG_REGISTRY[key].desc, category: configCategoryOf(key), value: getPath(target, key), stored: getPath(record, key) !== undefined }))
}
export async function setConfig(db, key, raw, target = globalThis) {
  descriptor(key)
  const value = coerceConfigValue(key, raw)
  const previous = getPath(target, key)
  setPath(configRecord(db), key, structuredClone(value))
  setPath(target, key, structuredClone(value))
  await db.save('config')
  return { key, value, previous }
}
export async function deleteConfig(db, key, target = globalThis) {
  descriptor(key)
  const record = configRecord(db)
  if (getPath(record, key) === undefined) throw new Error(`Tidak ada override untuk ${key}; nilainya sudah dari config.js.`)
  setPath(record, key, undefined)
  if (!defaultsSnapshot) captureConfigDefaults(target)
  const restored = defaultsSnapshot[key]
  setPath(target, key, restored === undefined ? undefined : structuredClone(restored))
  await db.save('config')
  return { key, restored }
}
