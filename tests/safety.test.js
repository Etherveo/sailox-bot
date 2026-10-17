import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { acquireProcessLock } from '../lib/helpers/sessionLock.js'
import { validatePublicURL, isPublicIP } from '../lib/helpers/net.js'
import { inspectPolicy } from '../lib/subbot/policy.js'
import { printError, setLogSink, printMessage } from '../lib/print.js'
import { smsg } from '../lib/simple.js'
import { raw, fakeConn } from './fixtures.js'
test('session lock rejects duplicate process and releases without touching credentials', async t => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-lock-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); const file = path.join(dir, 'process.lockfile'); const release = await acquireProcessLock(file); await assert.rejects(acquireProcessLock(file), /Instance lain/); await release(); const again = await acquireProcessLock(file); await again() })
test('URL validator blocks private, metadata, loopback, mapped IPv6, unsafe schemes and mixed DNS', async () => { for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '172.16.2.1', '100.64.1.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(isPublicIP(ip), false, ip); assert.equal(isPublicIP('8.8.8.8'), true); assert.equal(isPublicIP('2606:4700:4700::1111'), true); for (const url of ['file:///tmp/x', 'http://127.1/x', 'http://[::1]/', 'http://user:pass@example.com']) await assert.rejects(validatePublicURL(url, async () => [{ address: '8.8.8.8', family: 4 }])); await assert.rejects(validatePublicURL('https://example.test', async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.1.1.1', family: 4 }])); assert.equal((await validatePublicURL('https://example.test', async () => [{ address: '8.8.8.8', family: 4 }])).records[0].address, '8.8.8.8') })
test('owner execution sources cannot pass sub-bot policy', async () => { for (const name of ['exec', 'eval', 'o']) assert.throws(() => inspectPolicy(awaitDummy[name])); })
const awaitDummy = { exec: "let f = new (async()=>{}).constructor('m', code)", eval: "import cp from 'child_process'", o: "import { exec } from 'child_process'" }
test('print traverses causes/AggregateError, redacts secrets and masks message body', async () => { const lines = []; setLogSink(line => lines.push(line)); global.APIKeys = { a: 'private-api-key' }; global.logPrivacy = 'masked'; printError(new AggregateError([new Error('nested private-api-key')], 'outer', { cause: new Error('root') })); assert.ok(lines[0].includes('root')); assert.ok(lines[0].includes('nested')); assert.ok(!lines[0].includes('private-api-key')); const conn = fakeConn(); printMessage(smsg(conn, raw('private message body')), conn); assert.ok(!lines[1].includes('private message body')); await conn.store.close(); setLogSink(() => {}) })
