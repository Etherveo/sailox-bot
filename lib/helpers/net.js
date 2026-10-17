import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
export function isPublicIP(ip) {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113))
  }
  if (isIP(ip) === 6) { const first = parseInt(ip.split(':')[0], 16); return first >= 0x2000 && first <= 0x3fff && !ip.toLowerCase().startsWith('2001:db8:') && !ip.toLowerCase().startsWith('2002:') && !ip.toLowerCase().startsWith('2001:0:') }
  return false
}
export async function validatePublicURL(input, lookup = dns.lookup) {
  const url = new URL(input)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('URL publik HTTP(S) diperlukan')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const records = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true })
  if (!records.length || records.some(r => !isPublicIP(r.address))) throw new Error('Alamat jaringan privat/khusus ditolak')
  return { url, records }
}
export async function fetchPublicBuffer(input, { maxBytes = 20 * 1024 * 1024, timeoutMs = 30000, maxRedirects = 3, lookup = dns.lookup } = {}) {
  const signal = AbortSignal.timeout(timeoutMs)
  let current = input
  for (let i = 0; i <= maxRedirects; i++) {
    const { url, records } = await validatePublicURL(current, lookup)
    const result = await new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http).get(url, {
        signal, headers: { 'accept-encoding': 'identity' },
        lookup(host, options, cb) { const r = records[0]; cb(null, options.all ? records : r.address, r.family) },
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); resolve({ redirect: new URL(res.headers.location, url).href }); return }
        if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); reject(new Error('Unduhan gagal (HTTP)')); return }
        if (Number(res.headers['content-length']) > maxBytes || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) { res.destroy(); reject(new Error('Unduhan terlalu besar/terkompresi')); return }
        const chunks = []; let size = 0
        res.on('data', chunk => { size += chunk.length; if (size > maxBytes) res.destroy(new Error('Unduhan terlalu besar')); else chunks.push(chunk) })
        res.on('error', reject); res.on('end', () => resolve({ data: Buffer.concat(chunks, size), res: { status: res.statusCode, headers: res.headers } }))
      }); req.on('error', reject)
    })
    if (!result.redirect) return result
    current = result.redirect
  }
  throw new Error('Terlalu banyak redirect')
}
