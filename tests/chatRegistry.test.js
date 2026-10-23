import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createChatRegistry } from '../lib/helpers/chatRegistry.js'

test('registry: mencatat grup dan orang yang bernama; yang tanpa nama diabaikan', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'registry-'))
  let clock = 1000
  const reg = createChatRegistry({ root, now: () => clock, flushMs: 0 })
  try {
    assert.equal(await reg.record({ chatId: '111@g.us', chatName: 'Grup Tes', chatType: 'group', participantsCount: 7, senderId: '222@lid', senderJid: '628@s.whatsapp.net', senderName: 'Budi' }), true)
    assert.equal(await reg.record({ chatId: '333@s.whatsapp.net', senderId: '333@lid' }), false) // tanpa nama sama sekali
    assert.equal(await reg.record({ chatId: '444@s.whatsapp.net', chatName: 'Ani', chatType: 'dm', senderId: '444@lid', senderName: 'Ani' }), true)
    const snap = await reg.snapshot()
    assert.equal(snap.chats['111@g.us'].name, 'Grup Tes')
    assert.equal(snap.chats['111@g.us'].participants, 7)
    assert.equal(snap.chats['333@s.whatsapp.net'], undefined)
    assert.equal(snap.people['222@lid'].name, 'Budi')
    assert.equal(snap.people['222@lid'].jid, '628@s.whatsapp.net')
    assert.deepEqual(snap.people['222@lid'].chats, ['111@g.us'])
    assert.equal(snap.people['444@lid'].name, 'Ani')

    clock += 5000
    await reg.record({ chatId: '111@g.us', chatName: 'Grup Tes Baru', chatType: 'group', senderId: '222@lid', senderName: 'Budi' })
    const snap2 = await reg.snapshot()
    assert.equal(snap2.chats['111@g.us'].name, 'Grup Tes Baru')
    assert.equal(snap2.chats['111@g.us'].participants, 7) // nilai lama dipertahankan
    assert.equal(snap2.people['222@lid'].lastSeen, 6000)
  } finally { reg.stop(); await fsp.rm(root, { recursive: true, force: true }) }
})

test('registry: flush menulis file JSON dan instance baru membacanya kembali', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'registry-'))
  const reg = createChatRegistry({ root, now: () => 42, flushMs: 0 })
  try {
    await reg.record({ chatId: '999@g.us', chatName: 'Grup Awét', chatType: 'group', senderId: '888@lid', senderName: 'Cici' })
    await reg.flushNow()
    assert.ok(fs.existsSync(reg.file))
    const reg2 = createChatRegistry({ root, now: () => 43, flushMs: 0 })
    const snap = await reg2.snapshot()
    assert.equal(snap.chats['999@g.us'].name, 'Grup Awét')
    assert.equal(snap.people['888@lid'].name, 'Cici')
    reg2.stop()
  } finally { reg.stop(); await fsp.rm(root, { recursive: true, force: true }) }
})
