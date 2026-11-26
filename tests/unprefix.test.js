// tests/unprefix.test.js — .unprefix (plugins/group/unprefix.js) +
// fallback tanpa prefix di pipeline:
// - manajemen daftar per grup (tambah/list/del, cap 20, duplikat,
//   validasi kata harus cocok dengan perintah nyata),
// - gerbang admin grup + premium (founder lolos),
// - pemanggilan tanpa prefix lewat jalur normal pipeline (limit,
//   registrasi, gerbang plugin tujuan, handler.disabled tetap berlaku),
// - pencocokan whole-word case-insensitive (revisi Veo 2026-11-26:
//   'sa,' memicu, 'saya'/'satu'/'menuku' tidak).
// Dijalankan lewat pipeline asli + fake socket/db (pola
// tests/delete.test.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPipeline } from '../lib/plugins/pipeline.js'
import { Database } from '../lib/database/engine.js'
import { fakeConn, raw, PN, LID, BOTLID, GROUP } from './fixtures.js'
import { dayKey } from '../lib/helpers/time.js'
import { serialize } from '../lib/simple.js'
import { unprefixFallbackForPlugin, findUnprefixEntry } from '../lib/helpers/parsing.js'
import unprefix, { UNPREFIX_MAX, findUnprefixCommand, unprefixList } from '../plugins/group/unprefix.js'
import ping from '../plugins/info/ping.js'
import menu from '../plugins/main/menu.js'
import prefix from '../plugins/info/prefix.js'
import dump from '../plugins/owner/dump.js'
import ongoing from '../plugins/anime/ongoing.js'
import stickeraudio from '../plugins/sticker/stickeraudio.js'
import del from '../plugins/group/delete.js'
import chatsDescriptor from '../lib/database/collections/chats.js'

serialize()
const MEMBER = { id: '555000111222@lid', lid: '555000111222@lid', phoneNumber: '6289528749986@s.whatsapp.net', admin: null }
const ADMIN_PARTS = [
  { id: LID, phoneNumber: PN, admin: 'admin' },
  { id: BOTLID, phoneNumber: '6282234567890@s.whatsapp.net', admin: 'admin' },
  MEMBER,
]
const ENTRIES = [
  { id: 'group/unprefix.js', plugin: unprefix },
  { id: 'info/ping.js', plugin: ping },
  { id: 'main/menu.js', plugin: menu },
  { id: 'info/prefix.js', plugin: prefix },
  { id: 'owner/dump.js', plugin: dump },
  { id: 'anime/ongoing.js', plugin: ongoing },
  { id: 'sticker/stickeraudio.js', plugin: stickeraudio },
  { id: 'group/delete.js', plugin: del },
]

async function setup(t, participants = ADMIN_PARTS) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-unprefix-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const db = await new Database({ dir: root }).load()
  global.db = db
  const prevLimit = global.defaultLimit
  global.defaultLimit = 50
  t.after(() => { global.defaultLimit = prevLimit })
  const conn = fakeConn({ db })
  conn.groupMetadata = async id => ({ id, subject: 'Test group', participants })
  const loader = { root, list: () => ENTRIES }
  const prevLoader = globalThis.pluginLoader
  globalThis.pluginLoader = loader
  t.after(() => { if (prevLoader === undefined) delete globalThis.pluginLoader; else globalThis.pluginLoader = prevLoader })
  const pipeline = createPipeline({ db, plugins: loader, config: { prefix: '.', cooldownMs: 0, maxMessageAgeSec: 120 }, log: () => {}, error: () => {} })
  const run = (messages, type = 'notify') => pipeline.handler.call(conn, { type, messages })
  t.after(async () => { await pipeline.close(); await conn.store.close() })
  for (const key of [LID, PN, MEMBER.id]) {
    const u = db.ensure('users', key)
    u.registered = true; u.limitDay = dayKey(Date.now(), 'Asia/Jakarta'); u.limit = 50
  }
  db.ensure('chats', GROUP).isBanned = false
  db.ensure('chats', PN).isBanned = false
  const replies = () => conn.calls.filter(c => c.data?.text != null).map(c => c.data.text)
  let n = 0
  const nextId = () => 'u' + (++n)
  const list = () => unprefixList(db.data.chats[GROUP])
  const setPremium = (key, on) => { const u = db.ensure('users', key); u.premium = on; u.premiumTime = on ? 0 : 0 }
  return { db, conn, run, replies, nextId, list, setPremium }
}

const adminMsg = (s, text) => raw(text, { group: true, id: s.nextId() })
const memberMsg = (s, text) => raw(text, { group: true, participant: MEMBER.id, alt: false, id: s.nextId() })
const founderMsg = (s, text) => raw(text, { group: true, fromMe: true, id: s.nextId() })
const founderDM = (s, text) => raw(text, { group: false, fromMe: true, id: s.nextId() })

// ─── Logika murni: unprefixFallbackForPlugin + findUnprefixEntry ────────

test('unprefixFallbackForPlugin: kata utuh cocok (case-insensitive), kata menempel tidak; alias ikut', () => {
  assert.equal(unprefixFallbackForPlugin('ping', ping, '.'), '.ping')
  assert.equal(unprefixFallbackForPlugin('PING', ping, '.'), '.ping')
  assert.equal(unprefixFallbackForPlugin('ping,', ping, '.'), '.ping')
  assert.equal(unprefixFallbackForPlugin('ping! halo', ping, '.'), '.ping halo')
  assert.equal(unprefixFallbackForPlugin('p', ping, '.'), '.p', 'alias ikut tanpa prefix')
  assert.equal(unprefixFallbackForPlugin('P', ping, '.'), '.p')
  assert.equal(unprefixFallbackForPlugin('pingpong', ping, '.'), null)
  assert.equal(unprefixFallbackForPlugin('sa', stickeraudio, '.'), '.sa')
  assert.equal(unprefixFallbackForPlugin('Sa', stickeraudio, '.'), '.sa')
  assert.equal(unprefixFallbackForPlugin('SA', stickeraudio, '.'), '.sa')
  assert.equal(unprefixFallbackForPlugin('sa,', stickeraudio, '.'), '.sa')
  assert.equal(unprefixFallbackForPlugin('sa, foto', stickeraudio, '.'), '.sa foto')
  assert.equal(unprefixFallbackForPlugin('saya', stickeraudio, '.'), null)
  assert.equal(unprefixFallbackForPlugin('satu', stickeraudio, '.'), null)
  assert.equal(unprefixFallbackForPlugin('menu hari ini apa', menu, '.'), '.menu hari ini apa')
  assert.equal(unprefixFallbackForPlugin('Menu', menu, '.'), '.menu')
  assert.equal(unprefixFallbackForPlugin('MENU', menu, '.'), '.menu')
  assert.equal(unprefixFallbackForPlugin('menu, tolong', menu, '.'), '.menu tolong')
  assert.equal(unprefixFallbackForPlugin('menuku dong', menu, '.'), null)
  assert.equal(unprefixFallbackForPlugin('  sa', stickeraudio, '.'), '.sa', 'spasi awal di-trim')
  assert.equal(unprefixFallbackForPlugin('.sa', stickeraudio, '.'), null, 'pesan ber-prefix tidak lewat fallback')
  assert.equal(unprefixFallbackForPlugin('halo apa kabar', ping, '.'), null)
  assert.equal(unprefixFallbackForPlugin('', ping, '.'), null)
  assert.equal(unprefixFallbackForPlugin('sa', { before: () => {} }, '.'), null, 'plugin tanpa command → null')
})

test('findUnprefixEntry: kembalikan entry plugin, tolak regex kosong dan hook-only', () => {
  const entries = [
    { id: 'info/ping.js', plugin: ping },
    { id: 'info/prefix.js', plugin: prefix },
    { id: 'group/_antilink.js', plugin: { before: () => {} } },
  ]
  assert.equal(findUnprefixEntry('p', entries)?.id, 'info/ping.js')
  assert.equal(findUnprefixEntry('ping', entries)?.plugin, ping)
  assert.equal(findUnprefixEntry('P', entries)?.id, 'info/ping.js', 'case-insensitive')
  assert.equal(findUnprefixEntry('cekprefix', entries), null, 'command regex kosong /(?:)/ dilewati — bukan perintah bernama')
  assert.equal(findUnprefixEntry('zzz', entries), null)
  assert.equal(findUnprefixEntry('', entries), null)
  // Wrapper tipis di plugin tetap jalan (kompat tes lama):
  assert.equal(findUnprefixCommand('p', entries), ping)
  assert.equal(findUnprefixCommand('ping', entries), ping)
  assert.equal(findUnprefixCommand('cekprefix', entries), null)
})

// ─── Migrasi chats v1 -> v2 ────────────────────────────────────────────────

test('chats v2: record lama tanpa field unprefix mendapat [] saat load (fillMissing)', async t => {
  assert.equal(chatsDescriptor.version, 2, 'bump versi wajib supaya fillMissing jalan')
  assert.deepEqual(chatsDescriptor.defaults().unprefix, [])
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sailox-unprefix-mig-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const old = { isBanned: false, welcome: false, detect: false, delete: false, antiLink: false, game: false, rpg: false, nsfw: false, sWelcome: '', sBye: '', sPromote: '', sDemote: '', sDesc: '', sSubject: '', sIcon: '', sRevoke: '', swgc: 'admin', users: {} }
  await fs.writeFile(path.join(root, 'chats.json'), JSON.stringify({ [GROUP]: old }, null, 2))
  await fs.writeFile(path.join(root, '_meta.json'), JSON.stringify({ chats: 1 }))
  const db = await new Database({ dir: root }).load()
  assert.deepEqual(db.data.chats[GROUP].unprefix, [], 'record lama terisi default []')
  assert.equal(db.data.chats[GROUP].swgc, 'admin', 'field lama tidak rusak')
})

// ─── Metadata plugin ──────────────────────────────────────────────────────

test('metadata: satu plugin, tag group, premium + group, tanpa limit; admin dicek di handler (owner bebas); help 3 baris', () => {
  assert.equal(unprefix.command.test('unprefix'), true)
  assert.equal(unprefix.command.test('Unprefix'), true)
  assert.equal(unprefix.command.test('unprefixx'), false)
  assert.equal(unprefix.admin, undefined, 'gerbang admin di dalam handler — owner tidak perlu admin grup (Veo 2026-11-26)')
  assert.equal(unprefix.premium, true)
  assert.equal(unprefix.group, true)
  assert.equal(unprefix.limit, undefined, 'fitur grup bebas limit — keputusan Veo 2026-11-25')
  assert.deepEqual(unprefix.tags, ['group'])
  assert.deepEqual(unprefix.help, ['unprefix <perintah>', 'unprefix list', 'unprefix del <perintah>'])
  assert.equal(UNPREFIX_MAX, 20)
})

// ─── Manajemen daftar ─────────────────────────────────────────────────────

test('tambah: founder .unprefix sa → tersimpan + konfirmasi', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix sa')])
  assert.deepEqual(s.list(), ['sa'])
  assert.ok(s.replies().some(x => x.includes('sa') && x.includes('tanpa prefix')), s.replies())
  assert.ok(s.replies().some(x => x.includes('alias')), s.replies(), 'konfirmasi menyebut alias ikut tanpa prefix')
})

test('tambah: huruf besar dinormalisasi ke kecil', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix SA')])
  assert.deepEqual(s.list(), ['sa'])
})

test('tambah: duplikat ditolak sebagai info, daftar tidak berubah', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix sa')])
  await s.run([founderMsg(s, '.unprefix sa')])
  assert.deepEqual(s.list(), ['sa'])
  assert.ok(s.replies().some(x => x.includes('sudah ada')), s.replies())
})

test('tambah: kata yang bukan perintah ditolak', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix zzz')])
  assert.deepEqual(s.list(), [])
  assert.ok(s.replies().some(x => x.includes('Tidak ada perintah') && x.includes('zzz')), s.replies())
})

test('tambah: kata prefixless murni (cekprefix) ditolak — bukan perintah bernama', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix cekprefix')])
  assert.deepEqual(s.list(), [])
  assert.ok(s.replies().some(x => x.includes('Tidak ada perintah') && x.includes('cekprefix')), s.replies())
})

test('tambah: cap 20 kata per grup', async t => {
  const s = await setup(t)
  s.db.ensure('chats', GROUP).unprefix = Array.from({ length: 20 }, (_, i) => 'w' + (i + 1))
  await s.run([founderMsg(s, '.unprefix sa')])
  assert.equal(s.list().length, 20, 'daftar tidak bertambah')
  assert.ok(s.replies().some(x => x.includes('penuh') && x.includes('20')), s.replies())
})

test('list: kosong vs berisi', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix list')])
  assert.ok(s.replies().some(x => x.includes('Belum ada')), s.replies())
  await s.run([founderMsg(s, '.unprefix sa')])
  await s.run([founderMsg(s, '.unprefix menu')])
  await s.run([founderMsg(s, '.unprefix list')])
  const shown = s.replies().at(-1)
  assert.ok(shown.includes('sa') && shown.includes('menu'), shown)
  assert.ok(shown.includes('alias'), shown, 'list menjelaskan satu label = seluruh plugin termasuk alias')
})

test('del: hapus berhasil + hapus yang tidak ada', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix sa')])
  await s.run([founderMsg(s, '.unprefix menu')])
  await s.run([founderMsg(s, '.unprefix del sa')])
  assert.deepEqual(s.list(), ['menu'])
  assert.ok(s.replies().some(x => x.includes('dihapus')), s.replies())
  await s.run([founderMsg(s, '.unprefix del sa')])
  assert.ok(s.replies().some(x => x.includes('tidak ada di daftar')), s.replies())
})

test('del: .unprefix del tanpa kata kedua menambah kata del (alias .delete)', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix del')])
  assert.deepEqual(s.list(), ['del'], 'del adalah perintah nyata (alias delete), bukan subcommand tanpa argumen')
  await s.run([founderMsg(s, '.unprefix del del')])
  assert.deepEqual(s.list(), [])
})

test('tanpa argumen → usage', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix')])
  assert.ok(s.replies().some(x => x.includes('Cara pakai')), s.replies())
  assert.deepEqual(s.list(), [])
})

// ─── Gerbang .unprefix ────────────────────────────────────────────────────

test('gerbang: DM ditolak (group-only)', async t => {
  const s = await setup(t)
  await s.run([founderDM(s, '.unprefix sa')])
  assert.ok(s.replies().some(x => x.includes('Gunakan perintah ini di grup')), s.replies())
  assert.deepEqual(s.list(), [])
})

test('gerbang: member bukan admin ditolak', async t => {
  const s = await setup(t)
  s.setPremium(MEMBER.id, true) // premium lolos, jadi yang menolak adalah gerbang admin
  await s.run([memberMsg(s, '.unprefix sa')])
  assert.ok(s.replies().some(x => x.includes('khusus admin grup')), s.replies())
  assert.deepEqual(s.list(), [])
})

test('gerbang: owner bukan admin grup tetap bisa (perintah Veo 2026-11-26) — REGRESI: gagal bila gerbang admin masih handler.admin', async t => {
  // founderMsg = fromMe → isOwner; pengirimnya akun bot sendiri (BOTLID),
  // jadi BOTLID-lah yang dibuat bukan admin di metadata grup ini.
  const parts = [
    { id: LID, phoneNumber: PN, admin: null },
    { id: BOTLID, phoneNumber: '6282234567890@s.whatsapp.net', admin: null },
    MEMBER,
  ]
  const s = await setup(t, parts)
  await s.run([founderMsg(s, '.unprefix sa')])
  assert.deepEqual(s.list(), ['sa'])
  assert.ok(s.replies().some(x => x.includes('tanpa prefix')), s.replies())
})

test('gerbang: admin bukan premium ditolak', async t => {
  const s = await setup(t)
  await s.run([adminMsg(s, '.unprefix sa')])
  assert.ok(s.replies().some(x => x.includes('khusus premium')), s.replies())
  assert.deepEqual(s.list(), [])
})

// ─── Fallback tanpa prefix (lewat pipeline) ───────────────────────────────

test('fallback: bare p memicu .ping (Pong!) — REGRESI: gagal tanpa fallback pipeline', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix p')])
  assert.deepEqual(s.list(), ['p'])
  const before = s.replies().length
  await s.run([adminMsg(s, 'p')])
  assert.ok(s.replies().slice(before).some(x => x.startsWith('Pong!')), s.replies())
})

// ─── Alias: satu label = seluruh plugin ───────────────────────────────────

test('alias: tambah ping lalu bare p memicu Pong — REGRESI INTI: gagal dengan logika kata-lama', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix ping')])
  assert.deepEqual(s.list(), ['ping'])
  const before = s.replies().length
  await s.run([adminMsg(s, 'p')])
  assert.ok(s.replies().slice(before).some(x => x.startsWith('Pong!')), s.replies())
})

test('alias: tambah via p lalu bare ping memicu', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix p')])
  assert.deepEqual(s.list(), ['p'])
  const before = s.replies().length
  await s.run([adminMsg(s, 'ping')])
  assert.ok(s.replies().slice(before).some(x => x.startsWith('Pong!')), s.replies())
})

test('alias: tambah ping lalu tambah p → info duplikat menyebut label lama', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix ping')])
  await s.run([founderMsg(s, '.unprefix p')])
  assert.deepEqual(s.list(), ['ping'])
  assert.ok(s.replies().some(x => x.includes('sudah ada') && x.includes('ping')), s.replies())
})

test('alias: tambah ping, hapus via p → daftar kosong', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix ping')])
  await s.run([founderMsg(s, '.unprefix del p')])
  assert.deepEqual(s.list(), [])
  assert.ok(s.replies().some(x => x.includes('dihapus')), s.replies())
})

test('alias: entri lama ping (seed record) membuat bare p jalan tanpa perintah tambah', async t => {
  const s = await setup(t)
  s.db.ensure('chats', GROUP).unprefix = ['ping']
  const before = s.replies().length
  await s.run([adminMsg(s, 'p')])
  assert.ok(s.replies().slice(before).some(x => x.startsWith('Pong!')), s.replies())
})

test('fallback: bare sa memicu stickeraudio (usage tanpa media)', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix sa')])
  await s.run([adminMsg(s, 'sa')])
  assert.ok(s.replies().some(x => x.includes('Cara penggunaan:')), s.replies())
})

test('fallback: izin plugin tujuan tetap berlaku (owner-only dump ditolak non-owner, diam)', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix dump')])
  const before = s.replies().length
  await s.run([memberMsg(s, 'dump')])
  assert.deepEqual(s.replies().slice(before), [], 'penolakan founder diam ke pengirim — handler dump tidak jalan')
})

test('fallback: plugin disabled tetap ditolak', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix ongoing')])
  await s.run([adminMsg(s, 'ongoing')])
  assert.ok(s.replies().some(x => x.includes('dimatikan sementara')), s.replies())
})

test('whole-word: menuku/saya tidak memicu; Menu/MENU/menu, memicu', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix menu')])
  let before = s.replies().length
  await s.run([adminMsg(s, 'menuku dong')])
  assert.deepEqual(s.replies().slice(before), [], 'menuku tidak memicu')
  before = s.replies().length
  await s.run([adminMsg(s, 'saya mau menu')])
  assert.deepEqual(s.replies().slice(before), [], 'kata harus di awal pesan')
  for (const text of ['Menu', 'MENU', 'menu, tolong', 'menu hari ini apa']) {
    before = s.replies().length
    await s.run([adminMsg(s, text)])
    assert.ok(s.replies().slice(before).some(x => x.includes('Quick Navigation')), `${text} harus memicu .menu: ` + JSON.stringify(s.replies().slice(before)))
  }
})

test('whole-word: pagi tidak memicu p; p, dan P memicu', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix p')])
  let before = s.replies().length
  await s.run([adminMsg(s, 'pagi')])
  assert.deepEqual(s.replies().slice(before), [], 'pagi tidak memicu')
  for (const text of ['p,', 'P']) {
    before = s.replies().length
    await s.run([adminMsg(s, text)])
    assert.ok(s.replies().slice(before).some(x => x.startsWith('Pong!')), `${text} harus memicu .ping: ` + JSON.stringify(s.replies().slice(before)))
  }
})

test('prefix biasa tidak terganggu: .p dan .menuku', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix p')])
  await s.run([founderMsg(s, '.unprefix menu')])
  let before = s.replies().length
  await s.run([adminMsg(s, '.p')])
  assert.ok(s.replies().slice(before).some(x => x.startsWith('Pong!')), s.replies())
  before = s.replies().length
  await s.run([adminMsg(s, '.menuku')])
  assert.deepEqual(s.replies().slice(before), [], '.menuku bukan perintah dan tidak lewat fallback (ber-prefix)')
  before = s.replies().length
  await s.run([adminMsg(s, '.menu')])
  assert.ok(s.replies().slice(before).some(x => x.includes('Quick Navigation')), s.replies())
})

test('prefixless yang sudah ada didahulukan: bare cekprefix tetap dijawab cekprefix', async t => {
  const s = await setup(t)
  s.db.ensure('chats', GROUP).unprefix = ['cekprefix']
  await s.run([adminMsg(s, 'cekprefix')])
  assert.ok(s.replies().some(x => x.includes('Prefix aktif saat ini')), s.replies())
})

test('pesan biasa tidak memicu apa pun', async t => {
  const s = await setup(t)
  await s.run([founderMsg(s, '.unprefix p')])
  await s.run([founderMsg(s, '.unprefix menu')])
  const before = s.replies().length
  await s.run([adminMsg(s, 'halo apa kabar')])
  await s.run([adminMsg(s, 'saya')])
  assert.deepEqual(s.replies().slice(before), [], 'obrolan biasa diam')
})
