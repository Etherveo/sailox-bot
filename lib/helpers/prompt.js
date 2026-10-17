import readline from 'node:readline'
import { showLogin } from '../print.js'
const pending = [], buffered = []
let rl, installed = false
export function installPromptInput() {
  if (installed) return; installed = true
  const take = line => { const next = pending.shift(); if (next) next(line); else if (buffered.length < 10) buffered.push(line) }
  if (process.send) process.on('message', msg => { if (typeof msg === 'string') take(msg) })
  else { rl = readline.createInterface({ input: process.stdin }); rl.on('line', take); rl.on('close', () => { while (pending.length) pending.shift()(null) }) }
}
export function prompt(question) {
  installPromptInput(); showLogin(question)
  if (buffered.length) return Promise.resolve(buffered.shift())
  return new Promise(resolve => pending.push(resolve))
}
export function closePrompt() { rl?.close(); while (pending.length) pending.shift()(null) }
