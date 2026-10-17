export function splitText(text, max = 3500) { const chars = Array.from(String(text)); if (chars.length > 20000) chars.length = 20000; const out = []; for (let i = 0; i < chars.length; i += max) out.push(chars.slice(i, i + max).join('')); return out.length ? out : [''] }
export const escapeRE = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
