// tests/channelinfo.test.js — .channelinfo: parsing input link/kode/JID,
// normalisasi metadata mentah Baileys (thread_metadata/viewer_metadata)
// maupun bentuk datar, dan format balasan (termasuk peringatan peran).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import channelinfoHandler, { parseChannelInput, normalizeChannelMetadata, formatChannelInfo } from '../plugins/owner/channelinfo.js'

const RAW_FIXTURE = {
  id: '120363123456789012@newsletter',
  thread_metadata: {
    name: { id: '1', text: 'Saluran Veo', update_time: '1700000000' },
    description: { id: '2', text: 'Deskripsi saluran', update_time: '1700000000' },
    creation_time: '1700000000',
    invite: '0029VaAbCdEfGh',
    subscribers_count: '1234',
    verification: 'UNVERIFIED',
    picture: { direct_path: '/path', id: 'pic1', type: 'image' },
    preview: { direct_path: '/p', id: 'p1', type: 'image' },
  },
  viewer_metadata: { mute: 'OFF', role: 'ADMIN' },
}

function fakeConn(meta) {
  const calls = []
  return {
    calls,
    sendMessage: async (jid, content) => { calls.push({ jid, content }); return { key: { id: 'sent1' } } },
    newsletterMetadata: async (type, key) => { calls.push({ newsletterMetadata: { type, key } }); return meta },
  }
}
function fakeMsg(over = {}) {
  const replies = []
  const m = {
    chat: '120363999@g.us', sender: '62823@s.whatsapp.net', text: '', mtype: 'conversation',
    fromMe: false, key: { remoteJid: '120363999@g.us', id: 'msg1' },
    reply: async t => { replies.push(String(t)) },
    ...over,
  }
  m.replies = replies
  return m
}

// ─── Parsing input ──────────────────────────────────────────────────────────

test('channelinfo: parse link (dengan/tanpa skema, dengan id pesan)', () => {
  assert.deepEqual(parseChannelInput('https://whatsapp.com/channel/0029VaAbCdEfGh'), { type: 'invite', key: '0029VaAbCdEfGh' })
  assert.deepEqual(parseChannelInput('whatsapp.com/channel/0029VaAbCdEfGh'), { type: 'invite', key: '0029VaAbCdEfGh' })
  assert.deepEqual(parseChannelInput('https://whatsapp.com/channel/0029VaAbCdEfGh/175'), { type: 'invite', key: '0029VaAbCdEfGh' })
  assert.deepEqual(parseChannelInput('cek nih https://whatsapp.com/channel/0029VaAbCdEfGh ya'), { type: 'invite', key: '0029VaAbCdEfGh' })
})

test('channelinfo: parse JID, digit polos, dan kode polos', () => {
  assert.deepEqual(parseChannelInput('120363123456789012@newsletter'), { type: 'jid', key: '120363123456789012@newsletter' })
  assert.deepEqual(parseChannelInput('120363123456789012'), { type: 'jid', key: '120363123456789012@newsletter' })
  assert.deepEqual(parseChannelInput('0029VaAbCdEfGh'), { type: 'invite', key: '0029VaAbCdEfGh' })
})

test('channelinfo: parse menolak kosong dan format asing', () => {
  assert.throws(() => parseChannelInput(''), /Kirim salurannya/)
  assert.throws(() => parseChannelInput('halo dunia!'), /Format tidak dikenali/)
  assert.throws(() => parseChannelInput('62812@s.whatsapp.net'), /Format tidak dikenali/)
})

// ─── Normalisasi ────────────────────────────────────────────────────────────

test('channelinfo: normalize bentuk mentah Baileys', () => {
  const info = normalizeChannelMetadata(RAW_FIXTURE)
  assert.equal(info.id, '120363123456789012@newsletter')
  assert.equal(info.name, 'Saluran Veo')
  assert.equal(info.description, 'Deskripsi saluran')
  assert.equal(info.invite, '0029VaAbCdEfGh')
  assert.equal(info.subscribers, 1234)
  assert.equal(info.verification, 'UNVERIFIED')
  assert.equal(info.creationTime, 1700000000)
  assert.equal(info.role, 'ADMIN')
  assert.equal(info.hasPicture, true)
})

test('channelinfo: normalize bentuk datar dan input bukan-metadata', () => {
  const flat = normalizeChannelMetadata({ id: '1203631@newsletter', name: 'Flat', description: 'D', subscribers: 42, invite: 'AbC123', verification: 'VERIFIED' })
  assert.equal(flat.name, 'Flat')
  assert.equal(flat.subscribers, 42)
  assert.equal(flat.role, undefined)
  assert.equal(normalizeChannelMetadata(null), null)
  assert.equal(normalizeChannelMetadata({}), null, 'tanpa id bukan metadata')
  assert.equal(normalizeChannelMetadata('string'), null)
})

// ─── Format ─────────────────────────────────────────────────────────────────

test('channelinfo: format memuat semua field + hint set botChannel', () => {
  const out = formatChannelInfo(normalizeChannelMetadata(RAW_FIXTURE))
  assert.match(out, /Saluran Veo/)
  assert.match(out, /120363123456789012@newsletter/)
  assert.match(out, /Deskripsi saluran/)
  assert.match(out, /whatsapp\.com\/channel\/0029VaAbCdEfGh/)
  assert.match(out, /1\.234/)
  assert.match(out, /tidak terverifikasi/)
  assert.match(out, /admin/)
  assert.match(out, /2023-11-14/)
  assert.match(out, /\.config set botChannel 120363123456789012@newsletter/)
  assert.doesNotMatch(out, /bukan admin/)
})

test('channelinfo: format memperingatkan bila bot bukan admin', () => {
  const guest = normalizeChannelMetadata({ ...RAW_FIXTURE, viewer_metadata: { mute: 'OFF', role: 'GUEST' } })
  assert.match(formatChannelInfo(guest), /bukan admin/)
})

// ─── Handler ────────────────────────────────────────────────────────────────

test('channelinfo: terdaftar founder-only', () => {
  assert.equal(channelinfoHandler.founder, true)
  assert.deepEqual(channelinfoHandler.command, ['channelinfo'])
})

test('channelinfo: handler membalas metadata dari link', async () => {
  const conn = fakeConn(RAW_FIXTURE)
  const m = fakeMsg()
  await channelinfoHandler(m, { conn, text: 'https://whatsapp.com/channel/0029VaAbCdEfGh' })
  const q = conn.calls.find(c => c.newsletterMetadata)
  assert.deepEqual(q.newsletterMetadata, { type: 'invite', key: '0029VaAbCdEfGh' })
  assert.equal(m.replies.length, 1)
  assert.match(m.replies[0], /Saluran Veo/)
  assert.match(m.replies[0], /120363123456789012@newsletter/)
  assert.ok(conn.calls.some(c => c.content?.react?.text === '✅'))
})

test('channelinfo: handler memakai teks quoted bila argumen kosong', async () => {
  const conn = fakeConn(RAW_FIXTURE)
  const m = fakeMsg({ quoted: { text: '120363123456789012@newsletter' } })
  await channelinfoHandler(m, { conn, text: '' })
  const q = conn.calls.find(c => c.newsletterMetadata)
  assert.deepEqual(q.newsletterMetadata, { type: 'jid', key: '120363123456789012@newsletter' })
})

test('channelinfo: metadata null ditolak jelas, tanpa newsletterMetadata ditolak', async () => {
  const conn = fakeConn(null)
  await assert.rejects(channelinfoHandler(fakeMsg(), { conn, text: '1203631@newsletter' }), /tidak ditemukan/)
  const noApi = { sendMessage: async () => ({}) }
  await assert.rejects(channelinfoHandler(fakeMsg(), { conn: noApi, text: '1203631@newsletter' }), /tidak menyediakan API saluran/)
  await assert.rejects(channelinfoHandler(fakeMsg(), { conn, text: '' }), /Kirim salurannya/)
})
