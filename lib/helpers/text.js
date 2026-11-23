// Batas teks satu pesan WhatsApp (aturan pemilik 2026-11-19): 65536 karakter
// termasuk spasi. Melebihi batas -> potong, tampilkan 65536 karakter pertama
// SAJA, tanpa mengirim lanjutannya di pesan berikut. Dulu splitText memecah
// teks jadi pesan-pesan 3500 karakter (dan diam-diam membuang sisanya di atas
// 20000 karakter) -> spam, keterbacaan rusak. Bila butuh versi lengkap, plugin
// yang bersangkutan dirancang mengirim versi file — case by case, bukan dari
// dasar (contoh yang sudah begitu: .fetch melampirkan file lengkap).
export const WA_MAX_TEXT_CHARS = 65536
export function truncateText(text, max = WA_MAX_TEXT_CHARS) {
  const chars = Array.from(String(text))
  return chars.length > max ? chars.slice(0, max).join('') : String(text)
}
export const escapeRE = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Format ukuran byte (dipindah dari lib/helpers/diskUsage.js saat refactor
// aturan arsitektur 2026-10-28: satu-satunya bagian diskUsage yang dipakai
// lebih dari satu plugin — .du dan .clearcache).
export function formatSize(bytes = 0) {
  if (!bytes) return '0 B'
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + sizes[i]
}
