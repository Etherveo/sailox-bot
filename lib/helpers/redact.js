import { inspect } from 'node:util'
const secrets = new Set()
export function rememberSecret(value) { if (typeof value === 'string' && value.length >= 4) secrets.add(value) }
export function redact(value) {
  let s = typeof value === 'string' ? value : inspect(value, { depth: 3, maxArrayLength: 20, maxStringLength: 4000 })
  for (const secret of [...secrets, ...Object.values(global.APIKeys ?? {}), ...Object.entries(process.env).filter(([key]) => /TOKEN|SECRET|PASSWORD|API_?KEY/i.test(key)).map(([, value]) => value), global.pairing].filter(x => typeof x === 'string' && x.length >= 4)) s = s.replaceAll(secret, '#HIDDEN#')
  return s.replace(/((?:authorization|token|password|secret|api[_-]?key|creds|noiseKey|signedIdentityKey)\s*["']?\s*[:=]\s*)[^\s,}]+/gi, '$1#HIDDEN#').replace(/Bearer\s+\S+/gi, 'Bearer #HIDDEN#').replace(/https?:\/\/[^\s]+/g, url => url.replace(/([?&](?:key|token|secret|apikey)=)[^&\s]+/gi, '$1#HIDDEN#'))
}
