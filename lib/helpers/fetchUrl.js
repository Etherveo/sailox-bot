// Logika murni fitur fetch/get (adaptasi internet-fetch.js + internet-fetch2.js
// legacy). Dipisah dari plugin agar bisa dites unit tanpa jaringan; plugin di
// plugins/tools/fetch.js hanya mengurus unduhan (via net.js yang aman SSRF)
// dan pengiriman ke WhatsApp.
export const MAX_REPLY_CHARS = 65536

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/bmp': 'bmp', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/x-matroska': 'mkv', 'video/webm': 'webm',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/x-m4a': 'm4a', 'audio/flac': 'flac',
  'audio/wav': 'wav',
  'application/pdf': 'pdf', 'application/zip': 'zip', 'application/x-rar-compressed': 'rar',
  'application/json': 'json', 'application/xml': 'xml',
  'text/plain': 'txt', 'text/html': 'html', 'text/csv': 'csv', 'text/markdown': 'md',
}

export function mimeToExt(mime = '') {
  return MIME_EXT[String(mime).split(';')[0].trim().toLowerCase()] || 'bin'
}

// parseFetchArgs: uraikan argumen perintah menjadi { url: URL, forceDoc }.
// Flag "-d" (dari fetch2 legacy) memaksa kirim sebagai dokumen, bukan media.
// Melempar string pesan kesalahan/penggunaan agar plugin bisa langsung throw.
export function parseFetchArgs(text, { usedPrefix = '.', command = 'fetch' } = {}) {
  const usage = `Contoh penggunaan:\n${usedPrefix + command} <url>\n${usedPrefix + command} -d <url>  (paksa kirim sebagai dokumen)`
  let input = String(text ?? '').trim()
  if (!input) throw usage
  let forceDoc = false
  if (/^-d(\s|$)/.test(input)) { forceDoc = true; input = input.replace(/^-d(\s+|$)/, '').trim() }
  if (!input) throw usage
  if (!/^https?:\/\//i.test(input)) input = 'http://' + input
  let url
  try { url = new URL(input) } catch { throw `URL tidak valid: ${input}` }
  if (!['http:', 'https:'].includes(url.protocol)) throw `URL tidak valid: ${input}`
  return { url, forceDoc }
}

function baseFilename(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '')
    return name || 'file'
  } catch { return 'file' }
}

// planFetch: tentukan aksi pengiriman dari content-type + buffer yang sudah
// diunduh. Mengembalikan:
//   { kind: 'media', buffer, filename, caption }   — gambar/video/audio
//   { kind: 'text', buffer, filename, text }       — teks/JSON: dibalas ke chat
//                                                   (dipotong 65536 karakter;
//                                                    file dilampirkan hanya
//                                                    bila teks dipotong)
//   { kind: 'document', buffer, filename, caption } — sisanya / bila -d
export function planFetch({ url, contentType = '', buffer, forceDoc = false }) {
  const ct = String(contentType).split(';')[0].trim().toLowerCase()
  let filename = baseFilename(url)
  if (!/\.[a-z0-9]{1,8}$/i.test(filename)) filename += '.' + mimeToExt(ct)
  const info = { url: String(url), contentType: ct, size: buffer?.length ?? 0 }

  if (!forceDoc && (/^image\//.test(ct) || /^video\//.test(ct) || /^audio\//.test(ct))) {
    return { kind: 'media', buffer, filename, caption: '', info }
  }
  if (!forceDoc && (/^text\//.test(ct) || /^application\/json/.test(ct))) {
    const txt = buffer.toString('utf8')
    const truncated = txt.length > MAX_REPLY_CHARS
    return {
      kind: 'text', buffer, filename,
      text: truncated ? txt.slice(0, MAX_REPLY_CHARS) + '\n\n…(dipotong, file lengkap dilampirkan)' : txt,
      truncated, info,
    }
  }
  return {
    kind: 'document', buffer, filename,
    caption: `📎 ${filename}\n📦 ${(info.size / 1024).toFixed(1)} KB\n🔗 ${url}`,
    info,
  }
}
