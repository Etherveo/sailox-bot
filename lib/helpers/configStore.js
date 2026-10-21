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
  return Object.keys(CONFIG_REGISTRY).sort().map(key => ({ key, desc: CONFIG_REGISTRY[key].desc, value: getPath(target, key), stored: getPath(record, key) !== undefined }))
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
