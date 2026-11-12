import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootAnnounceText, sendBootAnnouncement } from '../lib/connection/bootAnnounce.js'

test('teks pengumuman boot: "Bot hidup" + jam WITA (bukan jam host)', () => {
  // 2026-11-12 14:40 WITA = 06:40 UTC
  assert.equal(bootAnnounceText(new Date('2026-11-12T06:40:00Z')), 'Bot hidup — 14:40 WITA')
  // Tengah malam WITA tetap 00:xx, bukan 23:xx WIB kemarin
  assert.equal(bootAnnounceText(new Date('2026-11-11T16:05:00Z')), 'Bot hidup — 00:05 WITA')
})

test('kirim sekali ke DM founder (PN@s.whatsapp.net) saat saklar hidup', async () => {
  const sent = []
  const sock = { sendMessage: async (jid, msg) => { sent.push([jid, msg]) } }
  const ok = await sendBootAnnouncement(sock, { enabled: true, founder: '6282348181097', now: new Date('2026-11-12T06:40:00Z') })
  assert.equal(ok, true)
  assert.deepEqual(sent, [['6282348181097@s.whatsapp.net', { text: 'Bot hidup — 14:40 WITA' }]])
})

test('diam bila saklar mati, founder kosong, atau kirim gagal (tanpa throw)', async () => {
  const sent = []
  const sock = { sendMessage: async (jid, msg) => { sent.push([jid, msg]) } }
  assert.equal(await sendBootAnnouncement(sock, { enabled: false, founder: '6282348181097' }), false)
  assert.equal(await sendBootAnnouncement(sock, { enabled: true, founder: '' }), false)
  assert.equal(await sendBootAnnouncement(sock, { enabled: true }), false)
  const failing = { sendMessage: async () => { throw new Error('jaringan putus') } }
  assert.equal(await sendBootAnnouncement(failing, { enabled: true, founder: '6282348181097' }), false)
  assert.deepEqual(sent, [])
})

test('tanpa opsi: baca saklar dari global.bootAnnounce (default hidup)', async () => {
  const sent = []
  const sock = { sendMessage: async (jid, msg) => { sent.push([jid, msg]) } }
  const previous = globalThis.bootAnnounce
  try {
    globalThis.bootAnnounce = false
    assert.equal(await sendBootAnnouncement(sock, { founder: '6282348181097' }), false)
    globalThis.bootAnnounce = true
    assert.equal(await sendBootAnnouncement(sock, { founder: '6282348181097' }), true)
    assert.equal(sent.length, 1)
  } finally {
    if (previous === undefined) delete globalThis.bootAnnounce
    else globalThis.bootAnnounce = previous
  }
})
