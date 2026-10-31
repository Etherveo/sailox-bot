export function splitText(text, max = 3500) { const chars = Array.from(String(text)); if (chars.length > 20000) chars.length = 20000; const out = []; for (let i = 0; i < chars.length; i += max) out.push(chars.slice(i, i + max).join('')); return out.length ? out : [''] }
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
