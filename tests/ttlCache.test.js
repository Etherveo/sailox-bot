import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TTLCache } from '../lib/helpers/cache.js'

test('TTLCache.has: ada sebelum kedaluwarsa, hilang sesudahnya (regresi inbound.has)', () => {
  let now = 1000
  const c = new TTLCache({ max: 10, ttl: 5000, now: () => now })
  assert.equal(c.has('a'), false)
  c.set('a', true)
  assert.equal(c.has('a'), true)
  now += 4999
  assert.equal(c.has('a'), true)
  now += 2
  assert.equal(c.has('a'), false, 'entri kedaluwarsa harus terbaca tidak ada')
  c.set('b', 123)
  assert.equal(c.has('b'), true)
  c.del('b')
  assert.equal(c.has('b'), false)
})
