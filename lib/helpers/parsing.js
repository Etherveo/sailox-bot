import { escapeRE } from './text.js'
function execAtStart(pattern, text, prefixChars = false) {
  if (Array.isArray(pattern)) { for (const p of pattern) { const m = execAtStart(p, text); if (m) return m } return null }
  const re = pattern instanceof RegExp ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')) : prefixChars ? new RegExp('^[' + escapeRE(String(pattern)).replace(/-/g, '\\-') + ']') : new RegExp('^' + escapeRE(String(pattern)), 'i')
  const m = re.exec(text); return m?.index === 0 ? m : null
}
export function commandMatches(pattern, command) {
  if (Array.isArray(pattern)) return pattern.some(p => commandMatches(p, command))
  if (pattern instanceof RegExp) return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(command)
  return typeof pattern === 'string' && pattern.toLowerCase() === command.toLowerCase()
}
export function parseCommand(plugin, input, prefix) {
  if (!input || plugin.command == null) return null
  const match = execAtStart(plugin.prefixless ?? prefix, input, plugin.prefixless == null && typeof prefix === 'string')
  if (!match || (!match[0] && plugin.prefixless == null)) return null
  const usedPrefix = match[0], noPrefix = input.slice(usedPrefix.length), body = noPrefix.trimStart(), token = /^\S*/.exec(body)[0], command = token.toLowerCase()
  if (!commandMatches(plugin.command, command)) return null
  const text = body.slice(token.length).trimStart(), args = text ? text.split(/\s+/) : []
  // Batas kata per perintah (anti-abuse). Plugin boleh menaikkan lewat
  // handler.maxArgs — .bcc butuh teks siaran panjang (pengumuman 144 kata
  // pernah ditolak diam-diam oleh batas ini, plugin tak pernah jalan).
  if (args.length > (plugin.maxArgs ?? 128)) return null
  return { match, usedPrefix, noPrefix, command, text, args, _args: noPrefix.split(/\s+/) }
}

// .unprefix (per-grup): bila pesan tidak ber-prefix dan kata pertamanya
// cocok whole-word (case-insensitive) dengan salah satu kata di daftar
// unprefix grup, kembalikan input sintetis seolah pesannya ber-prefix
// ('.' + kata + sisa) supaya parseCommand biasa bisa memakainya.
// Kata harus berdiri sendiri: 'sa,' memicu, 'saya'/'satu'/'menuku' tidak
// (batas kata \b). Sisa sesudah kata dibersihkan dari pemisah di depannya
// (spasi/koma/dll) supaya argumen tidak diawali tanda baca —
// 'sa, foto' -> '.sa foto', 'menu hari ini' -> '.menu hari ini'.
// Mengembalikan null bila tidak ada kata yang cocok (bukan pesan
// ber-prefix, bukan kata di daftar, atau kata menempel pada kata lain).
export function unprefixFallbackInput(input, words, prefix) {
  if (!input || !Array.isArray(words) || !words.length) return null
  const text = input.trimStart()
  if (!text) return null
  const prefixChars = typeof prefix === 'string' ? prefix : '.!/#$'
  if (prefixChars.includes(text[0])) return null
  for (const word of words) {
    const w = String(word ?? '').trim().toLowerCase()
    if (!w) continue
    const m = new RegExp('^' + escapeRE(w) + '\\b', 'i').exec(text)
    if (!m) continue
    const rest = text.slice(m[0].length).replace(/^[\s,;:!?]+/, '')
    return '.' + w + (rest ? ' ' + rest : '')
  }
  return null
}
