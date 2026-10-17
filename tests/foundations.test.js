import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TTLCache } from '../lib/helpers/cache.js'
import { WorkQueue, OutboundQueue } from '../lib/helpers/queue.js'
import { validateConfig } from '../lib/helpers/config.js'
import { redact } from '../lib/helpers/redact.js'
import '../config.example.js'
test('config template valid; malformed roles/config fail closed', () => { validateConfig(); assert.throws(() => validateConfig({ ...global, owner: [[]] }), /owner/); assert.throws(() => validateConfig({ ...global, pairing: 'bad' }), /pairing/) })
test('cache enforces LRU/TTL', () => { let t = 0; const c = new TTLCache({ max: 2, ttl: 10, now: () => t }); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3); assert.equal(c.get('b'), undefined); t = 11; assert.equal(c.get('a'), undefined) })
test('per-key queue preserves order; different keys bounded; no state retained', async () => { const q = new WorkQueue({ concurrency: 2 }); const a = []; await Promise.all([q.run('a', async () => { await Promise.resolve(); a.push(1) }), q.run('a', () => a.push(2)), q.run('b', () => a.push(3))]); assert.ok(a.indexOf(1) < a.indexOf(2)); assert.equal(q.lock.pending.size, 0); await q.close(); await assert.rejects(q.run('a', () => {})) })
test('outbound enforces global and per-chat spacing', async () => { let t = 0; const q = new OutboundQueue({ now: () => t, wait: async ms => { t += ms }, random: () => 0, perChatMs: 700, perSecond: 2 }); const times = []; for (const k of ['a', 'a', 'b']) await q.run(k, () => times.push(t)); assert.deepEqual(times, [0, 700, 1000]) })
test('redaction hides configured and structured secrets', () => { global.APIKeys = { demo: 'test-secret-key' }; assert.ok(!redact('token=abc test-secret-key').includes('abc')); assert.ok(!redact('test-secret-key').includes('test-secret-key')) })
test('queue concurrency never exceeds cap across many keys', async () => { const q = new WorkQueue({ concurrency: 3 }); let active = 0, maximum = 0; await Promise.all(Array.from({ length: 60 }, (_, i) => q.run('key' + (i % 20), async () => { active++; maximum = Math.max(active, maximum); await new Promise(resolve => setImmediate(resolve)); active-- }))); assert.equal(maximum, 3) })
