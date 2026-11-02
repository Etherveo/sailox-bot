// Generator nama human-readable berbasis pola V/C — diadaptasi dari
// generateSSIDs di fun-hack.js legacy: pola vokal/konsonan diturunkan
// supaya hasilnya "kebaca" (daftar konsonan memuat cluster seperti
// br/str/ng), bukan string acak polos. Mode -user mengadaptasi
// randUsername di fun-hackemail.js legacy (kataSifat_kataBenda+angka).
// Seluruh logika tinggal di plugin ini (aturan arsitektur §12): tidak
// ada fitur lain yang memakai mesin pola ini.
//
// Tata bahasa (urutan bebas):
//   .genname            → 1 nama, jumlah kata acak 2–4
//   .genname 3          → nama 3 kata (angka polos = jumlah kata, maks 6)
//   .genname n5         → 5 nama (maks 10)
//   .genname num        → huruf tertentu diganti angka (a→4, i→1, g→9, o→0)
//   .genname -ssid      → mode SSID ala .hack: numberize bisa muncul
//                         sendiri (27%), panjang dilunakkan di 25 karakter
//   .genname -user      → mode username email ala .hackemail; jumlah
//                         kata diabaikan (strukturnya tetap dua bagian)

const VOWELS = ['a', 'i', 'u', 'e', 'o']
const CONSONANTS = [
  'b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'w', 'y', 'z',
  // cluster umum (biar lebih "kebaca") — sama seperti legacy
  'br', 'cr', 'dr', 'fr', 'gr', 'pr', 'tr', 'st', 'str', 'sk', 'sp', 'pl', 'gl', 'kl', 'kh', 'ng', 'ny',
]
const LEET_MAP = { a: '4', A: '4', i: '1', I: '1', g: '9', G: '9', o: '0', O: '0' }
const SSID_TAGS = ['24', '99', '123', '5G', '2.4', '2024', '01', '88']
const USER_ADJECTIVES = ['dark', 'epic', 'silent', 'shadow', 'neon', 'blue', 'swift', 'lucky', 'mad', 'ultra']
const USER_NOUNS = ['wolf', 'coder', 'ninja', 'blade', 'fox', 'ghost', 'storm', 'byte', 'void', 'pixel']

const sample = (arr, random) => arr[Math.floor(random() * arr.length)]
const randInt = (min, max, random) => min + Math.floor(random() * (max - min + 1))
const clamp = (n, min, max) => Math.min(max, Math.max(min, n))

export function parseGennameArgs(text = '') {
  const result = { ok: true, words: null, count: 1, num: false, mode: 'base' }
  let wordsSeen = false
  let countSeen = false
  let modeSeen = false
  for (const token of String(text).trim().split(/\s+/).filter(Boolean)) {
    const lower = token.toLowerCase()
    if (/^\d+$/.test(token)) {
      if (!wordsSeen) { result.words = clamp(parseInt(token, 10), 1, 6); wordsSeen = true }
    } else if (/^n\d+$/.test(lower)) {
      if (!countSeen) { result.count = clamp(parseInt(lower.slice(1), 10), 1, 10); countSeen = true }
    } else if (lower === 'num') {
      result.num = true
    } else if (lower === '-ssid' || lower === '-user') {
      if (!modeSeen) { result.mode = lower.slice(1); modeSeen = true }
    } else {
      return { ok: false }
    }
  }
  return result
}

// Pola V/C acak pengganti pola turunan nama di legacy (di sini tidak ada
// nama target). Kunci keterbacaan legacy ternyata ada di langkah
// kompresnya: deret V/C per huruf dari nama asli dimampatkan per run,
// jadi pola akhirnya selalu selang-seling ketat — tidak pernah ada dua
// segmen sejenis berdampingan, dan tiap segmen konsonan berdiri sendiri
// di antara vokal (atau di tepi kata) persis seperti suku kata nama
// sungguhan. Pola acak di sini meniru sifat itu (tuning Veo 2026-11-01):
// mulai dari C (75%) atau V, lalu bergantian ketat, 3–6 segmen.
export function randomPattern(random = Math.random) {
  const len = randInt(3, 6, random)
  let mark = random() < 0.75 ? 'C' : 'V'
  const pattern = []
  for (let i = 0; i < len; i++) {
    pattern.push(mark)
    mark = mark === 'C' ? 'V' : 'C'
  }
  return pattern
}

// Variasi kecil pola antar kata dalam satu nama. Legacy menambah
// markah acak atau menukar dua segmen tetangga — keduanya mematahkan
// selang-seling, jadi di sini mutasinya dituning: menambah segmen
// hanya boleh markah lawan dari segmen terakhir, dan variasi kedua
// membalik urutan pola (ritme cermin, tetap selang-seling).
export function mutatePattern(pattern, step, random = Math.random) {
  const p = [...pattern]
  if (step > 0 && random() < 0.4 && p.length < 6) p.push(p.at(-1) === 'C' ? 'V' : 'C')
  if (random() < 0.25 && p.length >= 3) p.reverse()
  return p
}

// Buat satu "kata" mengikuti pola V/C agar terbaca — logika legacy,
// termasuk peluang 35% vokal penutup biar enak dibaca dan Title Case.
export function makeWordFromPattern(pattern, random = Math.random) {
  let out = ''
  for (const mark of pattern) out += mark === 'V' ? sample(VOWELS, random) : sample(CONSONANTS, random)
  if (random() < 0.35 && !VOWELS.includes(out.at(-1))) out += sample(VOWELS, random)
  return out.charAt(0).toUpperCase() + out.slice(1)
}

// Leet ala legacy: tiap huruf yang bisa diganti berpeluang 70%. Satu
// penyesuaian: bila tidak ada satu pun huruf terganti padahal ada yang
// bisa, huruf pertama yang bisa diganti dipaksa — supaya flag "num"
// tidak pernah pulang dengan tangan kosong.
export function leetNumberize(str, random = Math.random) {
  let replaced = false
  const out = [...str].map(ch => {
    const digit = LEET_MAP[ch]
    if (digit && random() < 0.7) { replaced = true; return digit }
    return ch
  }).join('')
  if (replaced) return out
  const idx = [...str].findIndex(ch => LEET_MAP[ch])
  if (idx === -1) return out
  return str.slice(0, idx) + LEET_MAP[str[idx]] + str.slice(idx + 1)
}

// Gaya "mix" dari maybeNumberize legacy: sisipkan tag angka umum tanpa
// merusak keterbacaan. Gaya full-numeric legacy sengaja tidak dipakai —
// hasilnya bukan nama lagi.
function tagNumberize(name, random) {
  const tag = sample(SSID_TAGS, random)
  const styles = [
    s => s + tag,
    s => tag + s,
    s => s.replace(/\b(\w{3,})\b/, m => m + tag),
    s => s.replace(/\s+/, ' ' + tag + ' '),
  ]
  const out = sample(styles, random)(name)
  return out === name ? name + tag : out
}

// Potong nama SSID di batas kata terdekat — logika legacy.
function smartTrim(s, limit) {
  if (s.length <= limit) return s
  s = s.replace(/\s{2,}/g, ' ')
  if (s.length <= limit) return s
  const cut = s.slice(0, limit)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 4 ? cut.slice(0, lastSpace) : cut).trim()
}

export function generateName({ words = null, mode = 'base', num = false } = {}, random = Math.random) {
  if (mode === 'user') {
    const base = `${sample(USER_ADJECTIVES, random)}_${sample(USER_NOUNS, random)}`
    return `${num ? leetNumberize(base, random) : base}${randInt(10, 9999, random)}`
  }
  const wordCount = words ?? randInt(2, 4, random)
  const basePattern = randomPattern(random)
  const parts = []
  for (let i = 0; i < wordCount; i++) parts.push(makeWordFromPattern(mutatePattern(basePattern, i, random), random))
  let name = parts.join(' ')
  if (mode === 'ssid') {
    // Tanpa flag num pun SSID legacy kadang berangka (27%): leet atau
    // tag-mix. Dengan num eksplisit, numberize-nya jadi pasti (leet).
    if (num) name = leetNumberize(name, random)
    else if (random() < 0.27) name = random() < 0.5 ? leetNumberize(name, random) : tagNumberize(name, random)
    if (name.length > 25) name = smartTrim(name, 25)
  } else if (num) {
    name = leetNumberize(name, random)
  }
  return name
}

export function generateNames(opts = {}, random = Math.random) {
  const count = opts.count ?? 1
  const out = new Set()
  let guard = 0
  while (out.size < count && guard++ < count * 20) out.add(generateName(opts, random))
  return [...out]
}

const usageText = (usedPrefix, command) => {
  const p = usedPrefix + command
  return `Contoh penggunaan:
${p} — 1 nama acak, 2–4 kata
${p} 3 n5 num — 5 nama, masing-masing 3 kata, huruf tertentu jadi angka
${p} -ssid — mode SSID (kadang berangka, maks 25 karakter)
${p} -user — mode username email (kataSifat_kataBenda + angka)

Angka polos = jumlah kata (maks 6), n<angka> = jumlah nama (maks 10), num = numberize, -ssid/-user = mode. Urutan bebas.`
}

let handler = async (m, { text, usedPrefix, command }) => {
  const parsed = parseGennameArgs(text ?? '')
  if (!parsed.ok) throw usageText(usedPrefix, command)
  const names = generateNames(parsed)
  await m.reply(names.length === 1 ? names[0] : names.map((name, i) => `${i + 1}. ${name}`).join('\n'))
}
handler.help = ['genname', 'genname 3 n5 num', 'genname -ssid', 'genname -user']; handler.tags = ['tools']; handler.command = /^genname$/i
export default handler
