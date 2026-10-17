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
function output(level, text) { const line = redact(`[${formatTime()}] ${level.toUpperCase()} ${text}`); lines.push(line); if (lines.length > 200) lines.shift(); sink(line) }
export const logger = { level: 'silent', child() { return this } }
for (const level of ['info', 'warn', 'error', 'debug', 'trace', 'success']) Object.defineProperty(logger, level, { value(...args) { output(level, args.map(a => typeof a === 'string' ? a : inspect(a, { depth: 2 })).join(' ')) } })
export function recent() { return [...lines] }
const g = chalk.gray
const formatSize = n => {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1)
  return `${(n / 1024 ** i).toFixed(i ? 2 : 0)} ${u[i]}`
}
const typeColor = t => /sticker/i.test(t) ? chalk.yellow : /image|video|audio|document/i.test(t) ? chalk.blue : /reaction/i.test(t) ? chalk.magenta : chalk.cyan
const row = (icon, label, value) => `${g('├─')} ${icon} ${chalk.dim(label.padEnd(9))}: ${value}`
export function printMessage(m, conn) {
  const masked = global.logPrivacy !== 'full' || conn.role === 'sub'
  const number = m.senderJid ? parsePhoneNumber('+' + jidDecode(m.senderJid).user).number?.international : ''
  const label = conn.role === 'sub' ? 'sub' : 'main'
  const chatName = m.isGroup ? conn.store?.cachedGroupMetadata(m.chat)?.subject || 'grup' : 'private'
  const size = Number(m.mediaMessage?.fileLength) || Buffer.byteLength(m.text)
  const user = global.db?.data.users[m.sender]
  const type = m.mtype ?? 'unknown'
  const roleTag = (label === 'sub' ? chalk.magenta : chalk.green)(label.toUpperCase())
  const chatKind = m.isGroup ? '👥 Grup' : '🙍 Private'
  const sender = masked ? chalk.dim('[disamarkan]') : chalk.white.bold(m.name || '-') + (number ? chalk.dim(` (${number})`) : '')
  const chat = masked ? chatKind : m.isGroup ? `${chatKind} — ${chalk.white(chatName)}` : chatKind
  const detail = masked ? [] : [m.msg?.fileName, m.msg?.mimetype, m.msg?.seconds ? `${m.msg.seconds} detik` : '', m.mentionedJid.length ? `${m.mentionedJid.length} mention` : ''].filter(Boolean)
  const styled = m.text.slice(0, 4000).replace(/\*([^*]+)\*/g, (_, t) => chalk.bold(t)).replace(/_([^_]+)_/g, (_, t) => chalk.italic(t)).replace(/~([^~]+)~/g, (_, t) => chalk.strikethrough(t))

  const out = [g(`\n╭─[ 📨 NEW MESSAGE · `) + roleTag + g(' ]' + '─'.repeat(28))]
  out.push(row('🆔', 'Type', typeColor(type).bold(type)))
  out.push(row('👤', 'Sender', sender))
  out.push(row('💬', 'Chat', chat))
  out.push(row('📦', 'Size', `${formatSize(size)} ${chalk.dim(`(${size} B)`)}`))
  out.push(row('🧪', 'Exp/Level', `${chalk.green(m.exp ?? 0)} / ${chalk.yellow(user?.level ?? 0)}`))
  if (detail.length) out.push(row('📎', 'Detail', detail.join(chalk.dim(' | '))))
  out.push(row('🤖', 'Bot', chalk.white(conn.user?.name || conn.user?.id || label)))
  if (masked) {
    out.push(`${g('╰─')} 🔒 ${chalk.dim('Isi pesan disamarkan')}`)
  } else if (styled.trim()) {
    out.push(`${g('├─')} 💌 ${chalk.dim('Message'.padEnd(9))}:`)
    const body = styled.split('\n')
    body.forEach((l, i) => out.push(`${g(i === body.length - 1 ? '╰─' : '│ ')}   ${chalk.white(l)}`))
  } else {
    out.push(`${g('╰─')} 💌 ${chalk.dim('(tanpa teks)')}`)
  }
  output('info', out.join('\n'))
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