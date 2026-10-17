import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { validateConfig } from '#lib/helpers/config.js'
import { logger, printError } from '#lib/print.js'
import { bootMain } from '#lib/connection/runtime.js'
const root = path.dirname(fileURLToPath(import.meta.url))
process.chdir(root)
try {
  await import('./config.js')
  validateConfig()
  const { values } = parseArgs({ options: { test: { type: 'boolean' }, login: { type: 'string' }, phone: { type: 'string' } }, strict: false })
  if (values.test) throw new Error('Gunakan npm test untuk tes offline')
  await bootMain({ root, loginMethod: values.login, phoneNumber: values.phone })
} catch (e) {
  if (e.code === 'ERR_MODULE_NOT_FOUND' && e.message.includes('config.js')) logger.error('config.js belum ada. Salin config.example.js ke config.js lalu isi identitas owner.')
  else printError(e, { module: 'boot' })
  process.exit(1)
}
