import chalk from 'chalk'
import { inspect } from 'node:util'
import { parsePhoneNumber } from 'awesome-phonenumber'
import { jidDecode } from '@whiskeysockets/baileys'
import { formatTime } from './helpers/time.js'
import { redact } from './helpers/redact.js'
export { redact } from './helpers/redact.js'
const lines = []
let sink = line => process.stdout.write(line + '\n')
export function setLogSink(fn) { sink = fn }
function output(level, text) {
  const line = redact(`[${formatTime()}] ${level.toUpperCase()} ${text}`);
  lines.push(line);
  if (lines.length > 200) lines.shift();
  sink(line)
}
export const logger = { level: 'silent', child() { return this } }
for (const level of ['info', 'warn', 'error', 'debug', 'trace', 'success']) Object.defineProperty(logger, level, { value(...args) { output(level, args.map(a => typeof a === 'string' ? a : inspect(a, { depth: 2 })).join(' ')) } })
export function recent() { return [...lines] }
export function printMessage(m, conn) {
  const masked = global.logPrivacy !== 'full' || conn.role === 'sub'
  const number = m.senderJid ? parsePhoneNumber('+' + jidDecode(m.senderJid).user).number?.international : ''
  const label = conn.role === 'sub' ? 'sub' : 'main'
  const chatName = m.isGroup ? conn.store?.cachedGroupMetadata(m.chat)?.subject || 'grup' : 'private'
  const size = Number(m.mediaMessage?.fileLength) || Buffer.byteLength(m.text)
  const user = global.db?.data.users[m.sender]
  const header = `[${label}] ${m.mtype ?? 'unknown'} | ${masked ? '[pengirim disamarkan]' : `${m.name} ${number || ''}`} | ${masked ? m.isGroup ? 'grup' : 'private' : chatName} | ${size} B | exp=${m.exp ?? 0} level=${user?.level ?? 0}`
  const detail = masked ? '' : [m.msg?.fileName, m.msg?.mimetype, m.msg?.seconds ? `${m.msg.seconds} detik` : '', m.mentionedJid.length ? `${m.mentionedJid.length} mention` : ''].filter(Boolean).join(' | ')
  const styled = m.text.slice(0, 4000).replace(/\*([^*]+)\*/g, (_, t) => chalk.bold(t)).replace(/_([^_]+)_/g, (_, t) => chalk.italic(t)).replace(/~([^~]+)~/g, (_, t) => chalk.strikethrough(t))
  output('info', chalk.cyan(header) + (masked ? '' : `\n${detail ? detail + '\n' : ''}${styled}`))
}
export function printError(err, context = {}) {
  const seen = new Set(), messages = []
  const visit = e => { if (seen.has(e)) return; seen.add(e); messages.push(e instanceof Error ? `${e.name}: ${e.message}\n${e.stack?.split('\n').slice(1, 9).join('\n') ?? ''}` : String(e)); if (e?.cause) visit(e.cause); if (e instanceof AggregateError) e.errors.forEach(visit) }
  visit(err)
  const safeContext = global.logPrivacy === 'full' ? context : { plugin: context.plugin, command: context.command }
  output('error', `${inspect(safeContext)} ${messages.join('\nCaused by: ')}`)
}
// Pairing/QR are displayed only to the interactive operator, never via the logger.
export function showLogin(text) { process.stdout.write(text + '\n') }
