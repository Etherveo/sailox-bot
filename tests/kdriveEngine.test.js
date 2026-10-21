import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import * as kdrive from '../lib/downloader/engines/kdrive.js'
import { inspectEngine } from '../lib/downloader/registry.js'
import { coerceConfigValue } from '../lib/helpers/configStore.js'

const WRAPPER = 'https://v1.kuramadrive.com/kdrive/AbC123xYz'
const ENDPOINT = 'https://anisphia.my.id/kdrive/AbC123xYz/Kuramanime-TEST-01-360p.mp4?lud=1&pid=2&sid=3&cce=1&upx=4'

// ─── match & parse ───────────────────────────────────────────────────────────

test('kdrive match: pembungkus + endpoint langsung diterima, domain peniru ditolak', () => {
  assert.equal(kdrive.match(WRAPPER), true)
  assert.equal(kdrive.match('https://v1.kuramadrive.com/kturbo/AbC123xYz'), true)
  assert.equal(kdrive.match(ENDPOINT), true)
  assert.equal(kdrive.match('https://9b82e27cb1c6534b3f978e449d303889.r2.cloudflarestorage.com/kuramadrive/ANIME/X/1/file.mp4'), true)
  assert.equal(kdrive.match('https://kuramadrive.com.evil.test/kdrive/AbC123xYz'), false)
  assert.equal(kdrive.match('https://evil.test/?u=kuramadrive.com/kdrive/x'), false)
  assert.equal(kdrive.match('https://anisphia.my.id/lainnya/AbC123xYz'), false)
  assert.equal(kdrive.match('https://pixeldrain.com/u/abc'), false)
})

test('kdrive parseKdriveUrl mengambil varian & id', () => {
  assert.deepEqual(kdrive.parseKdriveUrl(WRAPPER), { variant: 'kdrive', id: 'AbC123xYz' })
  assert.deepEqual(kdrive.parseKdriveUrl('https://kuramadrive.com/kturbo/Zz9'), { variant: 'kturbo', id: 'Zz9' })
  assert.throws(() => kdrive.parseKdriveUrl('https://example.com/x'), /tidak valid untuk kDrive/)
})

// ─── fetch palsu ─────────────────────────────────────────────────────────────

function endpointFetch(url, opts = {}) {
  const u = String(url)
  if (u.includes('anisphia.my.id')) {
    if (opts.headers?.Range) {
      return Promise.resolve(new Response('x', {
        status: 206,
        headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-0/12345' }
      }))
    }
    return Promise.resolve(new Response('isi-file', { status: 200, headers: { 'content-type': 'video/mp4' } }))
  }
  return Promise.reject(new Error('route tidak dikenal: ' + u))
}

const landingOkFetch = (url, opts = {}) => {
  const u = String(url)
  if (u.includes('kuramadrive.com')) {
    return Promise.resolve(new Response(`<html><a href="${ENDPOINT}">Unduh</a></html>`, {
      status: 200, headers: { 'content-type': 'text/html' }
    }))
  }
  return endpointFetch(url, opts)
}

const landing404Fetch = () => Promise.resolve(new Response('<h1>404 Not Found</h1>', { status: 404 }))

// ─── getInfo ─────────────────────────────────────────────────────────────────

test('kdrive getInfo: URL endpoint langsung di-probe (Range), tanpa kuramadrive', async () => {
  const info = await kdrive.getInfo(ENDPOINT, { fetchFn: endpointFetch })
  assert.equal(info.direct, true)
  assert.equal(info.fileUrl, ENDPOINT)
  assert.equal(info.size, 12345)
  assert.equal(info.fileName, 'Kuramanime-TEST-01-360p.mp4')
})

test('kdrive getInfo mode direct: resolusi dari halaman v1 ke endpoint', async () => {
  const info = await kdrive.getInfo(WRAPPER, { fetchFn: landingOkFetch })
  assert.equal(info.fileUrl, ENDPOINT)
  assert.equal(info.size, 12345)
})

test('kdrive getInfo mode direct: HTTP 404 dari v1 dijelaskan sebagai whitelist/stranger', async () => {
  await assert.rejects(kdrive.getInfo(WRAPPER, { fetchFn: landing404Fetch }), /whitelist/)
})

test('kdrive getInfo mode stranger: pembungkus ditolak, endpoint tetap jalan', async t => {
  globalThis.kdriveMode = 'stranger'
  t.after(() => { delete globalThis.kdriveMode })
  await assert.rejects(kdrive.getInfo(WRAPPER, { fetchFn: landingOkFetch }), /Mode stranger aktif/)
  const info = await kdrive.getInfo(ENDPOINT, { fetchFn: endpointFetch })
  assert.equal(info.direct, true)
})

// ─── download ────────────────────────────────────────────────────────────────

test('kdrive download: stream ke disk dengan nama dari mimetype', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-kdrive-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const info = { fileName: 'Kuramanime-TEST-01-360p.mp4', fileUrl: ENDPOINT, direct: true }
  const result = await kdrive.download(ENDPOINT, info, { destDir: dir, baseName: 'episode-tes', fetchFn: endpointFetch })
  assert.equal(result.fileName, 'episode-tes.mp4')
  assert.equal(result.size, 8)
  assert.equal(await fs.readFile(result.filePath, 'utf8'), 'isi-file')
})

// ─── integrasi registry & config ─────────────────────────────────────────────

test('kdrive engine lolos inspeksi kontrak registry', async () => {
  const code = await fs.readFile(new URL('../lib/downloader/engines/kdrive.js', import.meta.url), 'utf8')
  const { exports: ex } = inspectEngine(code)
  for (const wajib of ['id', 'match', 'getInfo', 'download']) assert.ok(ex.includes(wajib), `ekspor ${wajib}`)
})

test('config kdriveMode: enum direct|stranger tervalidasi', () => {
  assert.equal(coerceConfigValue('kdriveMode', 'direct'), 'direct')
  assert.equal(coerceConfigValue('kdriveMode', 'STRANGER'), 'stranger')
  assert.throws(() => coerceConfigValue('kdriveMode', 'bebas'), /direct | stranger|direct \| stranger/)
})
