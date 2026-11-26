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

// .unprefix (per-grup): satu kata di daftar = SELURUH plugin-nya,
// termasuk semua alias. Kata di daftar hanya label untuk mengenali
// plugin (mis. 'ping' mengenali plugin ping yang trigger-nya 'p' dan
// 'ping'); entri lama di chat.unprefix ikut perilaku baru tanpa migrasi.
//
// findUnprefixEntry: cari plugin yang perintahnya cocok dengan kata ini
// (dipakai pipeline untuk resolusi kata→plugin, dan dipakai plugin
// .unprefix untuk validasi). Dilewati: plugin bukan fungsi, tanpa
// command, dan command regex kosong /(?:)/ — itu perintah prefixless
// murni (cekprefix, odelete) yang memang tidak punya nama perintah.
// Mengembalikan entry {id, plugin} (bukan plugin saja) supaya pemanggil
// bisa membedakan dua plugin yang kebetulan cocok lewat id-nya.
export function findUnprefixEntry(word, entries) {
  const w = String(word ?? '').trim().toLowerCase()
  if (!w) return null
  for (const entry of entries ?? []) {
    const plugin = entry?.plugin
    if (typeof plugin !== 'function' || plugin.command == null) continue
    const commands = Array.isArray(plugin.command) ? plugin.command : [plugin.command]
    for (const c of commands) {
      if (c instanceof RegExp && c.source === '(?:)') continue
      if (typeof c === 'string' && !c) continue
      if (commandMatches(c, w)) return entry
    }
  }
  return null
}

// unprefixFallbackForPlugin: bila kata pertama pesan cocok dengan command
// plugin ini, kembalikan input sintetis seolah pesannya ber-prefix
// ('.' + kata + sisa) supaya parseCommand biasa bisa memakainya; bila
// tidak cocok kembalikan null. Kata harus berdiri sendiri —
// commandMatches memakai regex command yang berjangkar ^...$ sehingga
// 'sa,'/'sa'/'SA' memicu plugin .sa, tapi 'saya'/'satu'/'menuku' tidak.
// Sisa sesudah kata dibersihkan dari pemisah di depannya (spasi/koma/dll)
// supaya argumen tidak diawali tanda baca — 'sa, foto' -> '.sa foto',
// 'menu hari ini' -> '.menu hari ini', 'ping!' -> '.ping'.
// Mengembalikan null bila plugin tanpa command, pesan kosong, pesan
// ber-prefix, atau kata pertama bukan trigger plugin ini.
export function unprefixFallbackForPlugin(input, plugin, prefix) {
  if (!input || typeof plugin !== 'function' || plugin.command == null) return null
  const text = input.trimStart()
  if (!text) return null
  const prefixChars = typeof prefix === 'string' ? prefix : '.!/#$'
  if (prefixChars.includes(text[0])) return null
  const token = /^\S*/.exec(text)[0]
  const word = token.replace(/[,;:!?]+$/, '')
  if (!word || !commandMatches(plugin.command, word)) return null
  const rest = text.slice(token.length).replace(/^[\s,;:!?]+/, '')
  return '.' + word.toLowerCase() + (rest ? ' ' + rest : '')
}
