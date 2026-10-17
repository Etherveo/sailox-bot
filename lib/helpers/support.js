import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)
export async function detectSupport() { const support = {}; for (const [key, binary, args] of [['ffmpeg', 'ffmpeg', ['-version']], ['python', 'python3', ['--version']], ['php', 'php', ['--version']], ['java', 'java', ['-version']], ['javac', 'javac', ['-version']], ['cpp', 'g++', ['--version']]]) { try { await run(binary, args, { timeout: 3000, maxBuffer: 65536 }); support[key] = true } catch { support[key] = false } } return support }
