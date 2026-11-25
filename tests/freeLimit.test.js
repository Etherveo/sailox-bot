// tests/freeLimit.test.js — daftar bebas limit (keputusan Veo 2026-11-25):
// setiap perintah di bawah ini, setelah dipakai dengan sukses lewat
// pipeline asli, TIDAK mengurangi limit user (tetap 50). Sebagai
// kontrol, .timer/.alarm (yang tidak bebas) tetap memotong 1.
// Dijalankan lewat pipeline asli + fake socket/db supaya gerbang
// (registrasi, admin grup, bot admin) ikut teruji — bukan sekadar
// memeriksa handler.limit.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPipeline } from '../lib/plugins/pipeline.js'
import { Database } from '../lib/database/engine.js'
import { fakeConn, raw, PN, LID, GROUP } from './fixtures.js'
import { dayKey } from '../lib/helpers/time.js'
import { serialize } from '../lib/simple.js'
import pay from '../plugins/info/pay.js'
import profile from '../plugins/info/profile.js'
import ping from '../plugins/info/ping.js'
import owner from '../plugins/info/owner.js'
import afk from '../plugins/main/afk.js'
import menu from '../plugins/main/menu.js'
import tagme from '../plugins/tools/tagme.js'
import prefix from '../plugins/info/prefix.js'
import timer from '../plugins/tools/timer.js'
import alarm from '../plugins/tools/alarm.js'
import add from '../plugins/group/add.js'
import bukatutup from '../plugins/group/bukatutup.js'
import demote from '../plugins/group/demote.js'
import deletePlugin from '../plugins/group/delete.js'
import group from '../plugins/group/group.js'
import kick from '../plugins/group/kick.js'
import linkgc from '../plugins/group/linkgc.js'
import promote from '../plugins/group/promote.js'
import setdesc from '../plugins/group/setdesc.js'
import setnamagrup from '../plugins/group/setnamagrup.js'
import setppgrup from '../plugins/group/setppgrup.js'
import swgc from '../plugins/group/swgc.js'

serialize()
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='
const PNG = () => Buffer.from(PNG_B64, 'base64')

const PLUGIN_ENTRIES = [
  ['info/pay.js', pay], ['info/profile.js', profile], ['info/ping.js', ping],
  ['info/owner.js', owner], ['main/afk.js', afk], ['main/menu.js', menu],
  ['tools/tagme.js', tagme], ['info/prefix.js', prefix],
  ['tools/timer.js', timer], ['tools/alarm.js', alarm],
  ['group/add.js', add], ['group/bukatutup.js', bukatutup],
  ['group/demote.js', demote], ['group/delete.js', deletePlugin],
  ['group/group.js', group], ['group/kick.js', kick],
  ['group/linkgc.js', linkgc], ['group/promote.js', promote],
  ['group/setdesc.js', setdesc], ['group/setnamagrup.js', setnamagrup],
  ['group/setppgrup.js', setppgrup], ['group/swgc.js', swgc],
].map(([id, plugin]) => ({ id, plugin }))

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-freelimit-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const db = await new Database({ dir: root }).load()
  global.db = db
  const prevLimit = global.defaultLimit
  global.defaultLimit = 50
  t.after(() => { global.defaultLimit = prevLimit })
  const prevFounder = global.founder
  global.founder = [['6282348181097', '147368951459939', 'Veo']]
  t.after(() => { if (prevFounder === undefined) delete global.founder; else global.founder = prevFounder })
  const prevPrefix = global.prefix
  global.prefix = '.!/#$'
  t.after(() => { global.prefix = prevPrefix })
  const prevLoader = global.pluginLoader
  global.pluginLoader = { list: () => PLUGIN_ENTRIES }
  t.after(() => { if (prevLoader === undefined) delete global.pluginLoader; else global.pluginLoader = prevLoader })
  const conn = fakeConn({ db })
  // Stub metode grup yang tidak ada di fakeConn (tidak ada efek nyata).
  conn.groupInviteCode = async () => 'AbCdEfGhIjKlMnOpQrStUv'
  conn.groupSettingUpdate = async () => true
  conn.groupUpdateDescription = async () => true
  conn.groupUpdateSubject = async () => true
  conn.updateProfilePicture = async () => true
  conn.relayMessage = async () => ({ key: { id: 'sw1', remoteJid: GROUP, fromMe: true } })
  const loader = { root, list: () => PLUGIN_ENTRIES }
  const pipeline = createPipeline({ db, plugins: loader, config: { prefix: '.', cooldownMs: 0, maxMessageAgeSec: 120 }, log: () => {}, error: () => {} })
  const run = (messages, type = 'notify') => pipeline.handler.call(conn, { type, messages })
  t.after(async () => { await pipeline.close(); await conn.store.close() })
  for (const key of [LID, PN]) {
    const u = db.ensure('users', key)
    u.registered = true; u.limitDay = dayKey(Date.now(), 'Asia/Jakarta'); u.limit = 50
  }
  db.ensure('chats', GROUP).isBanned = false
  const replies = () => conn.calls.filter(c => c.data?.text != null).map(c => c.data.text)
  let n = 0
  const nextId = () => 'f' + (++n)
  const limit = () => db.data.users[LID].limit
  return { db, conn, run, replies, nextId, limit }
}

const groupCmd = (s, text) => raw(text, { group: true, id: s.nextId() })

// Satu tes per perintah bebas: perintah sukses (ada bukti balasan /
// kiriman) DAN limit tetap 50.
const FREE_CASES = [
  ['.pay', '.pay', null, s => !!s.conn.calls.find(c => c.data?.image)],
  ['.profile', '.profile', /Limit: 50\/50/, null],
  ['.p (ping)', '.p', /Pong!/, null],
  ['.owner', '.owner', null, s => !!s.conn.calls.find(c => c.data?.contacts)],
  ['.afk', '.afk istirahat', /Afk/, null],
  ['brb tanpa prefix', 'brb kabur dulu', /Afk/, null],
  ['.menu', '.menu', /Quick Navigation/, null],
  ['.tagme', '.tagme', /@6281234567890/, null],
  ['cekprefix tanpa prefix', 'cekprefix', /Prefix aktif/, null],
  ['.group', '.group', /Mode \.swgc/, null],
  ['.linkgc', '.linkgc', /chat\.whatsapp\.com\/AbCdEfGhIjKlMnOpQrStUv/, null],
  ['.opengc', '.opengc', /Grup dibuka/, null],
  ['.setdesc', '.setdesc Deskripsi baru', /Deskripsi grup diperbarui/, null],
  ['.setnamagrup', '.setnamagrup Nama Baru', /Nama grup diganti/, null],
  ['.add', '.add 628111222333', /berhasil ditambahkan/, null],
  ['.promote (target bukan member — handler tuntas)', '.promote 628111222333', /bukan member/, null],
  ['.demote (target bukan member — handler tuntas)', '.demote 628111222333', /bukan member/, null],
  ['.kick (target bukan member — handler tuntas)', '.kick 628111222333', /bukan member/, null],
  ['.swgc', '.swgc halo', /Status grup terkirim/, null],
  ['.timercheck', '.timercheck', /belum punya timer aktif/, null],
  ['.alarmcheck', '.alarmcheck', /belum punya alarm aktif/, null],
]

for (const [name, text, replyRe, sentCheck] of FREE_CASES) {
  test(`bebas limit: ${name} sukses dan limit tetap 50`, async t => {
    const s = await setup(t)
    await s.run([groupCmd(s, text)])
    if (replyRe) assert.ok(s.replies().some(x => replyRe.test(x)), `balasan ${name} tidak ditemukan: ${JSON.stringify(s.replies())}`)
    if (sentCheck) assert.ok(sentCheck(s), `kiriman ${name} tidak ditemukan`)
    assert.equal(s.limit(), 50, `${name} harus bebas limit`)
  })
}

// Kontrol: perintah yang TIDAK bebas tetap memotong 1.
test('kontrol: .timer tetap makan 1 limit', async t => {
  const s = await setup(t)
  await s.run([groupCmd(s, '.timer 15m')])
  assert.ok(s.replies().some(x => x.includes('Timer dipasang')), s.replies())
  assert.equal(s.limit(), 49)
})

test('kontrol: .alarm tetap makan 1 limit', async t => {
  const s = await setup(t)
  await s.run([groupCmd(s, '.alarm 10:30 pm wita')])
  assert.ok(s.replies().some(x => x.includes('Alarm dipasang')), s.replies())
  assert.equal(s.limit(), 49)
})

// .setppgrup: tidak bisa lewat pipeline — handler memanggil q.download()
// yang bermuara ke conn.downloadM, dan downloadM pada soket yang sudah
// di-decorate bersifat read-only (tidak bisa di-stub); unduhan media
// asli butuh URL + mediaKey WA yang tidak ada di tes. Yang dibuktikan
// di sini: handler-nya sukses (dengan download di-stub di pesan) dan
// plugin-nya tanpa handler.limit — pipeline hanya bisa memotong
// Number(plugin.limit), jadi potongannya 0 (dikunci invarian
// tests/pluginLimits.test.js).
test('bebas limit: .setppgrup sukses (handler langsung) dan tanpa handler.limit', async t => {
  const replies = []
  const m = {
    chat: GROUP, sender: LID, mtype: 'imageMessage',
    msg: { mimetype: 'image/jpeg' },
    download: async () => PNG(),
    reply: async text => { replies.push(String(text)) },
  }
  const conn = { updateProfilePicture: async () => true }
  await setppgrup(m, { conn, usedPrefix: '.', command: 'setppgrup' })
  assert.ok(replies.some(x => x.includes('Foto profil grup diganti')), replies)
  assert.equal(setppgrup.limit, undefined, '.setppgrup bebas limit — keputusan Veo 2026-11-25')
})
