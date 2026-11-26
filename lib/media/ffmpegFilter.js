// Escape path filesystem untuk nilai opsi di dalam string filter ffmpeg
// (-vf "..."). Parser filter memakai ':' sebagai pemisah opsi dan '\'
// sebagai escape, jadi path Windows mentah (`C:\Users\...`) hancur saat
// di-parse (ffmpeg 9.1 di laptop Veo: "No option name near
// 'UsersPublic...'" di brat + smeme).
//
// Aturannya TIDAK bisa ditebak — dibuktikan empiris dengan ffmpeg 8.1.2
// via execFile (persis jalur bot), path berisi ':'/','/';'/''':
//   1. '\' -> '/'  (ffmpeg menerima slash sebagai pemisah di Windows)
//   2. ':' -> '\\:' (DUA backslash — escaping ffmpeg dua level: level
//      graf memakan satu backslash, level opsi memakan satu lagi. Satu
//      backslash saja tetap gagal dengan error yang sama.)
//   3. ',' -> '\,'  dan  ';' -> '\;'  (satu backslash cukup)
//   4. "'" dibiarkan MENTAH — mentah lolos, di-escape (\') justru
//      merusak parse.
// Path POSIX tidak berubah (tidak ada karakter di atas). Dipakai bersama
// oleh brat.js dan smeme.js — dua-duanya membangun drawtext dengan
// fontfile/textfile dari path.join; duplikasi di dua file berisiko satu
// diperbaiki satunya tidak.
export function escapeFilterPath(p) {
  return String(p)
    .replace(/\\/g, '/')
    .replace(/:/g, '\\\\:')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
}
