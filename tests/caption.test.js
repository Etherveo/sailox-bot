import { test } from 'node:test'
import assert from 'node:assert/strict'
import { smsg } from '../lib/simple.js'
import { raw, fakeConn, PN } from './fixtures.js'

test('m.caption: terbaca dari media, kosong untuk pesan teks biasa', () => {
  const conn = fakeConn()
  const img = smsg(conn, raw('', { message: { imageMessage: { caption: 'halo dunia', mimetype: 'image/jpeg' } } }))
  assert.equal(img.caption, 'halo dunia')
  assert.equal(img.text, 'halo dunia', 'text tetap jatuh ke caption seperti sebelumnya')
  const vid = smsg(conn, raw('', { message: { videoMessage: { caption: 'video caption', mimetype: 'video/mp4', seconds: 3 } } }))
  assert.equal(vid.caption, 'video caption')
  const teks = smsg(conn, raw('halo'))
  assert.equal(teks.caption, '')
})

test('m.quoted.caption: caption media yang di-reply terbaca', () => {
  const conn = fakeConn()
  const m = smsg(conn, raw('', {
    message: {
      extendedTextMessage: {
        text: '.brat',
        contextInfo: { stanzaId: 'q1', participant: PN, quotedMessage: { imageMessage: { caption: 'caption dari quoted', mimetype: 'image/jpeg' } } },
      },
    },
  }))
  assert.equal(m.quoted?.caption, 'caption dari quoted')
  assert.equal(m.quoted?.text, 'caption dari quoted')
})
