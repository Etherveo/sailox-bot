import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preResolveKdrive, episodeCandidate } from '../lib/helpers/kdrivePreResolve.js'

const WRAPPER = 'https://v1.kuramadrive.com/kdrive/AbC123xYz'
const EPISODE = 'https://v20.kuramanime.ing/anime/5139/li-xiongmao/episode/15'
const ENDPOINT = 'https://anisphia.my.id/kdrive/AbC123xYz/file.mp4?lud=1'

test('episodeCandidate: hanya URL kuramanime yang dianggap konteks episode', () => {
  assert.equal(episodeCandidate(EPISODE), EPISODE)
  assert.equal(episodeCandidate('nama file custom'), undefined)
  assert.equal(episodeCandidate('https://pixeldrain.com/u/abc'), undefined)
  assert.equal(episodeCandidate(''), undefined)
  assert.equal(episodeCandidate(undefined), undefined)
})

test('preResolve direct + episode: resolusi lokal, slot nama dikosongkan', async () => {
  let seen
  const deps = {
    localResolve: async (url, opts) => { seen = { url, opts }; return { fileUrl: ENDPOINT } },
    relayResolve: async () => { throw new Error('relay tidak boleh dipanggil') }
  }
  const out = await preResolveKdrive({ conn: {}, url: WRAPPER, nameArg: EPISODE, config: { kdriveMode: 'direct' }, deps })
  assert.equal(out.url, ENDPOINT)
  assert.equal(out.nameArg, undefined)
  assert.equal(out.via, 'local-episode')
  assert.equal(seen.opts.episodeUrl, EPISODE)
})

test('preResolve direct tanpa episode: null (engine mencoba v1 & menjelaskan)', async () => {
  const deps = {
    localResolve: async () => { throw new Error('tidak boleh dipanggil') },
    relayResolve: async () => { throw new Error('tidak boleh dipanggil') }
  }
  const out = await preResolveKdrive({ conn: {}, url: WRAPPER, nameArg: 'nama custom', config: { kdriveMode: 'direct' }, deps })
  assert.equal(out, null)
})

test('preResolve stranger + peer: delegasi ke relay dengan konteks episode', async () => {
  let seen
  const deps = {
    relayResolve: async (conn, opts) => { seen = opts; return { fileUrl: ENDPOINT } },
    localResolve: async () => { throw new Error('lokal tidak boleh dipanggil') }
  }
  const out = await preResolveKdrive({ conn: {}, url: WRAPPER, nameArg: EPISODE, config: { kdriveMode: 'stranger', kdrivePeer: '628111' }, deps })
  assert.equal(out.via, 'relay')
  assert.equal(out.url, ENDPOINT)
  assert.equal(seen.episodeUrl, EPISODE)
})

test('preResolve stranger tanpa peer: null (engine menjelaskan mode stranger)', async () => {
  const deps = {
    relayResolve: async () => { throw new Error('tidak boleh dipanggil') },
    localResolve: async () => { throw new Error('tidak boleh dipanggil') }
  }
  const out = await preResolveKdrive({ conn: {}, url: WRAPPER, nameArg: EPISODE, config: { kdriveMode: 'stranger', kdrivePeer: '' }, deps })
  assert.equal(out, null)
})

test('preResolve: URL endpoint langsung tidak disentuh', async () => {
  const out = await preResolveKdrive({ conn: {}, url: ENDPOINT, nameArg: EPISODE, config: { kdriveMode: 'direct' }, deps: {} })
  assert.equal(out, null)
})
