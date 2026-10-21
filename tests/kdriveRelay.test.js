import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatRequest, formatOk, formatErr, formatPing,
  parseRelayMessage, handleRelayIncoming, requestResolution, requestPing,
  isKdriveWrapperUrl
} from '../lib/helpers/kdriveRelay.js'
import { resolveViaEpisode, sizeFromQualityLabel } from '../lib/kuramanime/resolve.js'
import { coerceConfigValue } from '../lib/helpers/configStore.js'

const WRAPPER = 'https://v1.kuramadrive.com/kdrive/AbC123xYz'
const EPISODE = 'https://v20.kuramanime.ing/anime/5139/li-xiongmao/episode/15'
const ENDPOINT = 'https://anisphia.my.id/kdrive/AbC123xYz/Kuramanime-LXNGMAO-15-360p-IQ.mp4?lud=1&pid=2&sid=3'

// ─── protokol ────────────────────────────────────────────────────────────────

test('relay protokol: format/parse bolak-balik', () => {
  const req = parseRelayMessage(formatRequest('abcd1234', { token: 'rahasia', url: WRAPPER, episodeUrl: EPISODE }))
  assert.equal(req.kind, 'REQ')
  assert.equal(req.token, 'rahasia')
  assert.equal(req.url, WRAPPER)
  assert.equal(req.episodeUrl, EPISODE)

  const reqNoEp = parseRelayMessage(formatRequest('abcd1234', { url: WRAPPER }))
  assert.equal(reqNoEp.episodeUrl, undefined)
  assert.equal(reqNoEp.token, '')

  const ok = parseRelayMessage(formatOk('abcd1234', { fileUrl: ENDPOINT, size: 103680316, fileName: 'Kuramanime-LXNGMAO-15-360p-IQ.mp4' }))
  assert.equal(ok.kind, 'OK')
  assert.equal(ok.fileUrl, ENDPOINT)
  assert.equal(ok.size, 103680316)
  assert.equal(ok.fileName, 'Kuramanime-LXNGMAO-15-360p-IQ.mp4')

  const err = parseRelayMessage(formatErr('abcd1234', 'gagal   total\nbanget'))
  assert.equal(err.kind, 'ERR')
  assert.equal(err.message, 'gagal total banget')

  assert.equal(parseRelayMessage('halo apa kabar'), null)
  assert.equal(parseRelayMessage('KDR1 NGACO x'), null)
  assert.equal(isKdriveWrapperUrl(WRAPPER), true)
  assert.equal(isKdriveWrapperUrl(ENDPOINT), false)
})

// ─── loopback dua bot ────────────────────────────────────────────────────────

function makePair({ tokenA = 's3cret', tokenB = 's3cret', modeA = 'direct' } = {}) {
  const cfgA = { kdriveMode: modeA, kdrivePeer: '628222', kdriveRelayToken: tokenA }
  const cfgB = { kdriveMode: 'stranger', kdrivePeer: '628111', kdriveRelayToken: tokenB }
  const resolveStub = async (url, { episodeUrl } = {}) => {
    assert.equal(url, WRAPPER)
    return { fileUrl: ENDPOINT, size: 103680316, fileName: 'Kuramanime-LXNGMAO-15-360p-IQ.mp4', via: episodeUrl ? 'episode-page' : 'landing-page' }
  }
  const deliver = (toCfg, toConn, fromNumber) => (jid, { text }) => {
    const m = { text, sender: `${fromNumber}@s.whatsapp.net`, senderJid: `${fromNumber}@s.whatsapp.net`, chat: `${fromNumber}@s.whatsapp.net`, isGroup: false, fromMe: false }
    queueMicrotask(() => { handleRelayIncoming(toConn, m, { config: toCfg, resolve: resolveStub }).catch(() => {}) })
    return Promise.resolve()
  }
  const connA = { sendMessage: null }
  const connB = { sendMessage: null }
  connA.sendMessage = deliver(cfgB, connB, '628111')
  connB.sendMessage = deliver(cfgA, connA, '628222')
  return { cfgA, cfgB, connA, connB }
}

test('relay loopback: stranger meminta, resolver menjawab, fileUrl diterima utuh', async () => {
  const { cfgB, connB } = makePair()
  const info = await requestResolution(connB, { url: WRAPPER, episodeUrl: EPISODE, config: cfgB, timeoutMs: 5000 })
  assert.equal(info.fileUrl, ENDPOINT)
  assert.equal(info.size, 103680316)
  assert.equal(info.fileName, 'Kuramanime-LXNGMAO-15-360p-IQ.mp4')
})

test('relay loopback: PING dijawab PONG', async () => {
  const { cfgB, connB } = makePair()
  const ms = await requestPing(connB, { config: cfgB, timeoutMs: 5000 })
  assert.equal(typeof ms, 'number')
})

test('relay: token tidak cocok -> request menggantung lalu timeout (diam, fail-closed)', async () => {
  const { cfgB, connB } = makePair({ tokenB: 'salah' })
  await assert.rejects(
    requestResolution(connB, { url: WRAPPER, config: cfgB, timeoutMs: 300 }),
    /Relay timeout/
  )
})

test('relay: bot mode stranger menolak jadi resolver', async () => {
  const { cfgB, connB } = makePair({ modeA: 'stranger' })
  await assert.rejects(
    requestResolution(connB, { url: WRAPPER, config: cfgB, timeoutMs: 5000 }),
    /bukan resolver/
  )
})

test('relay: REQ dari nomor asing diabaikan total', async () => {
  const cfgA = { kdriveMode: 'direct', kdrivePeer: '628222', kdriveRelayToken: '' }
  const replies = []
  const conn = { sendMessage: async (jid, { text }) => { replies.push(text) } }
  const m = { text: formatRequest('deadbeef', { url: WRAPPER }), sender: '628999@s.whatsapp.net', senderJid: '628999@s.whatsapp.net', chat: '628999@s.whatsapp.net', isGroup: false, fromMe: false }
  const handled = await handleRelayIncoming(conn, m, { config: cfgA, resolve: async () => ({ fileUrl: 'x' }) })
  assert.equal(handled, false)
  assert.equal(replies.length, 0)
})

// ─── resolver episode ────────────────────────────────────────────────────────

test('resolveViaEpisode: pasangan id<->streaming + ukuran pasti dari probe', async () => {
  const page = {
    contentError: null,
    downloads: [
      { quality: 'MP4 360p (Hardsub) — (98.88 MB)', host: 'v1.kuramadrive.com', url: WRAPPER },
      { quality: 'MKV 720p (Softsub) — (324.27 MB)', host: 'v1.kuramadrive.com', url: 'https://v1.kuramadrive.com/kdrive/MKV720id' }
    ],
    streaming: [{ quality: '360p', url: ENDPOINT }]
  }
  const probeFetch = async () => new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/103680316' } })
  const info = await resolveViaEpisode('AbC123xYz', EPISODE, { fetchEpisodePage: async () => page, fetchFn: probeFetch })
  assert.equal(info.fileUrl, ENDPOINT)
  assert.equal(info.size, 103680316)
  assert.equal(info.fileName, 'Kuramanime-LXNGMAO-15-360p-IQ.mp4')

  await assert.rejects(
    resolveViaEpisode('MKV720id', EPISODE, { fetchEpisodePage: async () => page, fetchFn: probeFetch }),
    /sumber streaming pasangannya/
  )
  assert.equal(sizeFromQualityLabel('MP4 360p (Hardsub) — (98.88 MB)'), Math.round(98.88 * 1024 * 1024))
})

test('config kdrivePeer: string nomor terdaftar di registry', () => {
  assert.equal(coerceConfigValue('kdrivePeer', '6285133340742'), '6285133340742')
  assert.equal(coerceConfigValue('kdrivePeer', ''), '')
})
