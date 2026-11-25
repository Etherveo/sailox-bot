export function formatTime(t = Date.now(), timezone = global.timezone ?? 'Asia/Jakarta') { return new Intl.DateTimeFormat('id-ID', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(t) }
export function duration(ms) { const s = Math.max(0, Math.floor(Number(ms) / 1000)); return [[Math.floor(s / 86400), 'hari'], [Math.floor(s / 3600) % 24, 'jam'], [Math.floor(s / 60) % 60, 'menit'], [s % 60, 'detik']].filter(([n]) => n).map(x => x.join(' ')).join(' ') || '0 detik' }
// Kunci hari 'YYYY-MM-DD' di zona waktu yang diminta (untuk reset limit
// harian): dua timestamp di hari yang sama (zona bot) berbagi kunci yang
// sama, dan hari berganti tepat tengah malam zona itu.
export function dayKey(t = Date.now(), timezone = global.timezone ?? 'Asia/Jakarta') { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t) }
