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
  if (args.length > 128) return null
  return { match, usedPrefix, noPrefix, command, text, args, _args: noPrefix.split(/\s+/) }
}
