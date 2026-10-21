import { parsePhoneNumber } from 'awesome-phonenumber'

const ROLE_KEYS = ['founder', 'owner', 'mods']
const DIGITS = /^\d{7,15}$/
const LID_DIGITS = /^\d{1,30}$/
const PAIRING_CODE = /^[A-Za-z0-9]{8}$/

/**
 * Validate a prefix accepted by the command parser.
 * String prefixes are interpreted as a set of prefix characters by the parser.
 * Arrays may contain strings and/or RegExp instances.
 */
export function validatePrefix(prefix) {
  const validItem = item => {
    if (item instanceof RegExp) return true
    return typeof item === 'string' && item.length > 0 && item.length <= 32 && !/[\r\n\0]/.test(item)
  }

  if (typeof prefix === 'string') {
    if (!validItem(prefix)) throw new TypeError('prefix harus berupa string 1–32 karakter tanpa baris baru')
    return prefix
  }
  if (prefix instanceof RegExp) return prefix
  if (Array.isArray(prefix) && prefix.length > 0 && prefix.length <= 32 && prefix.every(validItem)) return prefix

  throw new TypeError('prefix harus berupa string, RegExp, atau array string/RegExp yang valid')
}

function validateRole(key, value) {
  if (!Array.isArray(value)) throw new TypeError(`${key} harus berupa array`)
  const seenNumbers = new Set()

  for (let i = 0; i < value.length; i++) {
    const entry = value[i]
    if (!Array.isArray(entry) || entry.length !== 3) {
      throw new TypeError(`${key}[${i}] harus berbentuk [nomor, lidNumber, nama]`)
    }

    const [number, lidNumber, name] = entry
    if (typeof number !== 'string' || !DIGITS.test(number)) {
      throw new TypeError(`${key}[${i}].nomor harus berupa 7–15 digit tanpa tanda +`)
    }
    if (seenNumbers.has(number)) throw new TypeError(`${key} memiliki nomor duplikat`)
    seenNumbers.add(number)

    if (typeof lidNumber !== 'string' || (lidNumber !== '' && !LID_DIGITS.test(lidNumber))) {
      throw new TypeError(`${key}[${i}].lidNumber harus berupa digit atau string kosong`)
    }
    if (typeof name !== 'string' || !name.trim() || name.length > 100) {
      throw new TypeError(`${key}[${i}].nama harus berupa string 1–100 karakter`)
    }
  }
}

/** Validate the runtime config without printing any configured values/secrets. */
export function validateConfig(config = globalThis) {
  for (const key of ROLE_KEYS) validateRole(key, config[key])

  if (config.pairing !== undefined && config.pairing !== '' &&
      (typeof config.pairing !== 'string' || !PAIRING_CODE.test(config.pairing))) {
    throw new TypeError('pairing harus kosong atau tepat 8 karakter alfanumerik')
  }

  if (config.nomorbot !== undefined && config.nomorbot !== '') {
    if (typeof config.nomorbot !== 'string' || !DIGITS.test(config.nomorbot)) {
      throw new TypeError('nomorbot harus berupa 7–15 digit tanpa tanda +, atau string kosong')
    }
    let phone
    try { phone = parsePhoneNumber(`+${config.nomorbot}`) } catch { phone = null }
    if (!phone?.valid) throw new TypeError('nomorbot bukan nomor telepon internasional yang valid')
  }

  validatePrefix(config.prefix)

  if (config.timezone !== undefined) {
    if (typeof config.timezone !== 'string' || !config.timezone.trim()) {
      throw new TypeError('timezone harus berupa nama zona waktu')
    }
    try { new Intl.DateTimeFormat('en-US', { timeZone: config.timezone }) }
    catch { throw new TypeError('timezone bukan zona waktu yang dikenal') }
  }

  if (config.countryCode !== undefined &&
      (typeof config.countryCode !== 'string' || !/^\d{1,3}$/.test(config.countryCode))) {
    throw new TypeError('countryCode harus berupa 1–3 digit')
  }
  if (config.defaultLimit !== undefined &&
      (!Number.isInteger(config.defaultLimit) || config.defaultLimit < 0)) {
    throw new TypeError('defaultLimit harus berupa bilangan bulat non-negatif')
  }

  return true
}
