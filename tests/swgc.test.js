// tests/swgc.test.js — .swgc status grup (plugins/group/swgc.js):
// pemilihan sumber konten (teks / media sendiri / media reply),
// pembungkusan groupStatusMessageV2 lewat generator resmi Baileys
// dengan uploader soket yang di-stub, gerbang mode per grup
// (all/admin/none dari record chats), dan .group set
// (plugins/group/group.js) yang mengatur mode itu.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proto, unpadRandomMax16 } from '@whiskeysockets/baileys'
import swgcHandler, { buildSwgcInner, reuseMediaContent, sendGroupStatus, relayGroupStatusMedia, forkMediaType, forkStanzaType, swgcMode, assertSwgcAllowed, swgcAuthorJid, SWGC_MAX_TEXT } from '../plugins/group/swgc.js'
import groupHandler, { parseGroupSet } from '../plugins/group/group.js'

const GROUP = '120363999888777@g.us'
// Proto media "sumber" ala klien WhatsApp asli: lengkap dengan
// jpegThumbnail + dimensi — persis yang dipakai ulang plugin.
const SRC_IMG_MSG = {
  caption: 'caption lama', url: 'https://mmg.whatsapp.net/asli.enc', directPath: '/asli.enc',
  mimetype: 'image/jpeg', fileLength: 12345, width: 720, height: 720,
  jpegThumbnail: Buffer.alloc(64, 7), mediaKey: Buffer.alloc(32, 5),
  contextInfo: { stanzaId: 'pesan-asli', quotedMessage: { conversation: 'konteks lama' } },
}

function fakeConn(over = {}) {
  const calls = { relay: [], sent: [], nodes: [], encrypt: [] }
  const conn = {
    calls,
    relayMessage: async (jid, message, opts) => { calls.relay.push({ jid, message, opts }); return { key: { id: 'status1' } } },
    sendMessage: async (jid, content) => { calls.sent.push({ jid, content }); return { key: { id: 'react1' } } },
    // Permukaan soket untuk relay fork-style: metadata grup, authState,
    // signalRepository (enkripsi sender-key menangkap payload mentah
    // supaya tes bisa mendekode & memeriksanya), dan sendNode.
    groupMetadata: async () => ({ id: GROUP, addressingMode: 'lid', participants: [] }),
    authState: {
      creds: { me: { id: '6285133340742@s.whatsapp.net', lid: '555000111@lid' } },
      keys: { get: async () => ({ [GROUP]: { '628111222333@s.whatsapp.net': true } }) },
    },
    signalRepository: {
      hasSenderKey: async () => true,
      encryptGroupMessage: async ({ data }) => { calls.encrypt.push(data); return { ciphertext: Buffer.from('cipher') } },
    },
    sendNode: async (stanza) => { calls.nodes.push(stanza) },
    ...over,
  }
  return conn
}

const baseM = (conn, over = {}) => ({
  chat: GROUP, sender: '628111222333@s.whatsapp.net', mtype: 'conversation', text: '', quoted: null,
  key: { remoteJid: GROUP, id: 'msg1', participant: '628111222333@s.whatsapp.net' },
  conn, replies: [],
  reply: async function (t) { this.replies.push(String(t)) },
  ...over,
})

test('swgc: flag grup saja (gerbang mode di dalam handler), perintah swgc/upswgc/swgroup', () => {
  assert.equal(swgcHandler.group, true)
  assert.equal(swgcHandler.admin, undefined)
  assert.equal(swgcHandler.botAdmin, undefined)
  assert.deepEqual(swgcHandler.command, ['swgc', 'upswgc', 'swgroup'])
  assert.deepEqual(swgcHandler.tags, ['group'])
})

test('swgc: teks saja dirakit generator sebagai extendedTextMessage tanpa pratinjau tautan', async () => {
  let seen = null
  const inner = await buildSwgcInner(baseM(fakeConn()), '  Halo semua!  ', async content => { seen = content; return { extendedTextMessage: { text: content.text } } })
  assert.deepEqual(seen, { text: 'Halo semua!', linkPreview: null })
  assert.equal(inner.extendedTextMessage.text, 'Halo semua!')
})

test('swgc: tanpa teks dan tanpa media ditolak dengan usage', async () => {
  await assert.rejects(buildSwgcInner(baseM(fakeConn()), '   '), /Kirim\/reply gambar/)
})

test('swgc: teks kepanjangan ditolak', async () => {
  await assert.rejects(buildSwgcInner(baseM(fakeConn()), 'x'.repeat(SWGC_MAX_TEXT + 1)), /kepanjangan/)
})

test('swgc: reuseMediaContent — field sumber utuh, contextInfo diganti blok status resmi, salinan dalam', () => {
  const src = { mtype: 'imageMessage', msg: SRC_IMG_MSG }
  const inner = reuseMediaContent(src, undefined, '6713788895365@lid').imageMessage
  assert.equal(inner.caption, 'caption lama')
  assert.equal(inner.url, 'https://mmg.whatsapp.net/asli.enc')
  assert.equal(Buffer.from(inner.jpegThumbnail).length, 64)
  assert.equal(inner.width, 720)
  // contextInfo sumber (stanzaId dsb.) hilang, diganti penanda status
  assert.equal(inner.contextInfo.stanzaId, undefined)
  assert.equal(inner.contextInfo.isGroupStatus, true)
  // Blok status meniru dump asli: forwardingScore eksplisit + eligibilities lengkap
  assert.ok(Object.hasOwn(inner.contextInfo, 'forwardingScore'))
  assert.equal(inner.contextInfo.forwardingScore, 0)
  assert.deepEqual(inner.contextInfo.featureEligibilities, { cannotBeRanked: false, canBeReshared: false, canReceiveMultiReact: true })
  // Verifikasi di level wire: enum harus sampai sebagai angka yang benar,
  // dan field bernilai 0/false harus BENAR-BENAR ter-encode (toObject
  // tanpa defaults hanya menampilkan field yang hadir di wire).
  const wire = proto.Message.toObject(proto.Message.decode(proto.Message.encode({ groupStatusMessageV2: { message: { imageMessage: inner } } }).finish()))
  const ci = wire.groupStatusMessageV2.message.imageMessage.contextInfo
  assert.equal(ci.statusSourceType, 0, 'StatusSourceType.IMAGE')
  assert.equal(ci.pairedMediaType, 0, 'PairedMediaType.NOT_PAIRED_MEDIA')
  assert.equal(ci.statusAttributions[0].type, 5, 'StatusAttribution.Type.GROUP_STATUS')
  assert.equal(ci.statusAttributions[0].groupStatus.authorJid, '6713788895365@lid')
  assert.equal(ci.isGroupStatus, true)
  assert.equal(ci.featureEligibilities.canReceiveMultiReact, true)
  assert.ok(Object.hasOwn(ci, 'forwardingScore'), 'forwardingScore: 0 hadir di wire seperti dump asli')
  assert.ok(Object.hasOwn(ci.featureEligibilities, 'cannotBeRanked'), 'cannotBeRanked: false hadir di wire')
  inner.caption = 'diubah'
  assert.equal(SRC_IMG_MSG.caption, 'caption lama', 'sumber asli tidak ikut berubah')
})

test('swgc: reply gambar tanpa teks mempertahankan caption lama; dengan teks menimpa', async () => {
  const quoted = { mtype: 'imageMessage', msg: SRC_IMG_MSG }
  const keep = await buildSwgcInner(baseM(fakeConn(), { quoted }), '')
  assert.equal(keep.imageMessage.caption, 'caption lama')
  const over = await buildSwgcInner(baseM(fakeConn(), { quoted }), 'caption baru')
  assert.equal(over.imageMessage.caption, 'caption baru')
})

test('swgc: media pada pesan perintah sendiri didahulukan, caption dipaksa dari teks sesudah perintah', async () => {
  const m = baseM(fakeConn(), { mtype: 'videoMessage', msg: { caption: '.swgc', seconds: 4, jpegThumbnail: Buffer.alloc(10, 3) } })
  const inner = await buildSwgcInner(m, 'teks baru')
  assert.equal(inner.videoMessage.caption, 'teks baru')
  assert.equal(Number(inner.videoMessage.seconds), 4)
  const kosong = await buildSwgcInner(m, '')
  assert.equal(kosong.videoMessage.caption, '')
})

test('swgc: reply audio dipakai ulang apa adanya, teks tidak jadi caption, sourceType AUDIO', async () => {
  const quoted = { mtype: 'audioMessage', msg: { ptt: true, mimetype: 'audio/ogg; codecs=opus', url: 'https://mmg.whatsapp.net/a.enc' } }
  const inner = await buildSwgcInner(baseM(fakeConn(), { quoted }), 'diabaikan', undefined, '6713788895365@lid')
  assert.equal(inner.audioMessage.ptt, true)
  assert.equal(inner.audioMessage.mimetype, 'audio/ogg; codecs=opus')
  assert.equal(inner.audioMessage.caption, undefined)
  assert.equal(inner.audioMessage.contextInfo.statusSourceType, 3, 'StatusSourceType.AUDIO')
  assert.equal(inner.audioMessage.contextInfo.statusAttributions[0].groupStatus.authorJid, '6713788895365@lid')
})

test('swgc: media sumber tidak lengkap dilaporkan jujur', async () => {
  const quoted = { mtype: 'imageMessage', msg: null }
  await assert.rejects(buildSwgcInner(baseM(fakeConn(), { quoted }), ''), /tidak lengkap/)
})

test('swgc: sendGroupStatus membungkus isi ke groupStatusMessageV2 dan proto round-trip utuh', async () => {
  const conn = fakeConn()
  await sendGroupStatus(conn, GROUP, { extendedTextMessage: { text: 'Halo status grup' } })
  assert.equal(conn.calls.relay.length, 1)
  const { jid, message } = conn.calls.relay[0]
  assert.equal(jid, GROUP)
  assert.equal(message.groupStatusMessageV2.message.extendedTextMessage.text, 'Halo status grup')
  const decoded = proto.Message.decode(proto.Message.encode(message).finish())
  assert.equal(decoded.groupStatusMessageV2.message.extendedTextMessage.text, 'Halo status grup')
})

test('swgc: swgcAuthorJid mengikuti addressingMode grup seperti relayMessage', () => {
  const conn = { user: { id: '6285133340742@s.whatsapp.net', lid: '555000111@lid' } }
  assert.equal(swgcAuthorJid(conn, { addressingMode: 'lid' }), '555000111@lid')
  assert.equal(swgcAuthorJid(conn, { addressingMode: 'pn' }), '6285133340742@s.whatsapp.net')
  assert.equal(swgcAuthorJid(conn, undefined), '555000111@lid', 'tanpa metadata: bawaan lid')
  assert.equal(swgcAuthorJid({ user: { id: '6285133340742@s.whatsapp.net' } }, { addressingMode: 'lid' }), '6285133340742@s.whatsapp.net', 'lid kosong: jatuh ke PN')
  assert.equal(swgcAuthorJid({}, undefined), '')
  const withDevice = { user: { id: '6285133340742:6@s.whatsapp.net', lid: '555000111:6@lid' } }
  assert.equal(swgcAuthorJid(withDevice, { addressingMode: 'lid' }), '555000111@lid', 'sufiks device dibuang — authorJid dump asli selalu bersih')
})

test('swgc: forkMediaType/forkStanzaType meniru @pontalabs/baileys — mediatype dari isi ter-normalisasi, audio status type text', () => {
  const wrap = message => ({ groupStatusMessageV2: { message } })
  assert.equal(forkMediaType(wrap({ imageMessage: {} })), 'image')
  assert.equal(forkStanzaType(wrap({ imageMessage: {} })), 'media')
  assert.equal(forkMediaType(wrap({ videoMessage: {} })), 'video')
  assert.equal(forkMediaType(wrap({ videoMessage: { gifPlayback: true } })), 'gif')
  assert.equal(forkMediaType(wrap({ audioMessage: { ptt: true } })), undefined, 'audio terbungkus status: tanpa mediatype (perilaku fork)')
  assert.equal(forkStanzaType(wrap({ audioMessage: { ptt: true } })), 'text', 'audio terbungkus status: stanza type text (perilaku fork)')
  assert.equal(forkMediaType(wrap({ extendedTextMessage: { text: 'x' } })), undefined)
  assert.equal(forkStanzaType(wrap({ extendedTextMessage: { text: 'x' } })), 'text')
})

test('swgc: messageSecret duduk di level LUAR payload (sejajar bungkus status), bukan di dalam inner — sesuai dump asli', async () => {
  const quoted = { mtype: 'imageMessage', msg: SRC_IMG_MSG }
  const inner = await buildSwgcInner(baseM(fakeConn(), { quoted }), '', undefined, '6713788895365@lid')
  assert.equal(inner.messageContextInfo, undefined, 'inner message bersih dari messageContextInfo')
  const conn = fakeConn()
  await sendGroupStatus(conn, GROUP, inner)
  // Media berangkat lewat relay fork-style: payload diperiksa dari
  // bytes yang diserahkan ke encryptGroupMessage (terenkripsi sesudah itu).
  assert.equal(conn.calls.nodes.length, 1)
  const payload = proto.Message.decode(unpadRandomMax16(conn.calls.encrypt[0]))
  assert.equal(Buffer.from(payload.messageContextInfo.messageSecret).length, 32)
  assert.ok(payload.groupStatusMessageV2, 'bungkus status tetap ada di sebelahnya')
  assert.ok(payload.groupStatusMessageV2.message.messageContextInfo == null, 'inner tetap bersih')
})

test('swgc: relay fork-style — stanza sender-key membawa mediatype image + type media + addressing_mode', async () => {
  const conn = fakeConn()
  const payload = { messageContextInfo: { messageSecret: Buffer.alloc(32, 1) }, groupStatusMessageV2: { message: { imageMessage: { caption: 'x' } } } }
  const result = await relayGroupStatusMedia(conn, GROUP, payload)
  assert.equal(conn.calls.relay.length, 0, 'relayMessage bawaan tidak dipakai')
  assert.equal(conn.calls.nodes.length, 1)
  const stanza = conn.calls.nodes[0]
  assert.equal(stanza.tag, 'message')
  assert.equal(stanza.attrs.to, GROUP)
  assert.equal(stanza.attrs.type, 'media')
  assert.equal(stanza.attrs.addressing_mode, 'lid')
  assert.ok(stanza.attrs.id)
  assert.equal(result.key.id, stanza.attrs.id)
  const enc = stanza.content[0]
  assert.equal(enc.tag, 'enc')
  assert.equal(enc.attrs.type, 'skmsg')
  assert.equal(enc.attrs.mediatype, 'image', 'inilah atribut yang hilang di Baileys resmi rc14')
  assert.equal(String(enc.content), 'cipher')
})

test('swgc: relay fork-style jatuh kembali ke relayMessage bawaan bila sender key grup belum siap', async () => {
  const conn = fakeConn({ signalRepository: { hasSenderKey: async () => false, encryptGroupMessage: async () => ({ ciphertext: Buffer.from('x') }) } })
  const payload = { groupStatusMessageV2: { message: { imageMessage: {} } } }
  await relayGroupStatusMedia(conn, GROUP, payload)
  assert.equal(conn.calls.nodes.length, 0, 'sendNode tidak dipakai')
  assert.equal(conn.calls.relay.length, 1, 'relayMessage bawaan menangani distribusi kunci')
})

test('swgc: handler gambar ujung-ke-ujung — stanza fork-style, payload berisi proto sumber + atribusi LID bot', async () => {
  const conn = fakeConn({ user: { id: '6285133340742@s.whatsapp.net', lid: '555000111@lid' } })
  const quoted = { mtype: 'imageMessage', msg: SRC_IMG_MSG }
  const m = baseM(conn, { quoted })
  await swgcHandler(m, { conn, text: '', chat: {}, isAdmin: true })
  assert.equal(conn.calls.nodes.length, 1, 'terkirim lewat sendNode (relay fork-style)')
  assert.equal(conn.calls.nodes[0].content[0].attrs.mediatype, 'image')
  const payload = proto.Message.decode(unpadRandomMax16(conn.calls.encrypt[0]))
  const img = payload.groupStatusMessageV2.message.imageMessage
  assert.equal(img.url, 'https://mmg.whatsapp.net/asli.enc')
  assert.equal(Buffer.from(img.jpegThumbnail).length, 64)
  assert.equal(img.contextInfo.isGroupStatus, true)
  assert.equal(img.contextInfo.statusAttributions[0].groupStatus.authorJid, '555000111@lid', 'authorJid diambil dari conn.user.lid')
  assert.equal(Buffer.from(payload.messageContextInfo.messageSecret).length, 32, 'messageSecret di level luar payload')
})

test('swgc: handler ujung-ke-ujung teks — relay sekali, react ⏳→✅, balasan konfirmasi', async () => {
  const conn = fakeConn()
  const m = baseM(conn)
  await swgcHandler(m, { conn, text: 'Pengumuman grup', chat: {}, isAdmin: true })
  assert.equal(conn.calls.relay.length, 1)
  assert.equal(conn.calls.relay[0].message.groupStatusMessageV2.message.extendedTextMessage.text, 'Pengumuman grup')
  const reacts = conn.calls.sent.filter(c => c.content.react).map(c => c.content.react.text)
  assert.deepEqual(reacts, ['⏳', '✅'])
  assert.match(m.replies[0], /Status grup terkirim/)
})

test('swgc: kegagalan relay dilaporkan dengan pesan error aslinya', async () => {
  const conn = fakeConn({ relayMessage: async () => { throw new Error('boom 403 dari server') } })
  const m = baseM(conn)
  await assert.rejects(swgcHandler(m, { conn, text: 'halo', chat: {}, isAdmin: true }), /boom 403 dari server/)
  const reacts = conn.calls.sent.filter(c => c.content.react).map(c => c.content.react.text)
  assert.deepEqual(reacts, ['⏳', '⚠️'])
})

test('swgc: swgcMode — bawaan admin, nilai sah dinormalisasi, nilai asing jatuh ke admin', () => {
  assert.equal(swgcMode(undefined), 'admin')
  assert.equal(swgcMode({}), 'admin')
  assert.equal(swgcMode({ swgc: 'ALL' }), 'all')
  assert.equal(swgcMode({ swgc: 'none' }), 'none')
  assert.equal(swgcMode({ swgc: 'aneh' }), 'admin')
})

test('swgc: gerbang mode — none menolak semua, admin menolak non-admin, all meloloskan', async () => {
  assert.throws(() => assertSwgcAllowed('none', { isAdmin: true }), /dimatikan di grup ini/)
  assert.throws(() => assertSwgcAllowed('admin', { isAdmin: false }), /cuma buat admin grup/)
  assert.doesNotThrow(() => assertSwgcAllowed('admin', { isAdmin: true }))
  assert.doesNotThrow(() => assertSwgcAllowed('all', { isAdmin: false }))
  // Ujung-ke-ujung: mode all → non-admin tetap terkirim; mode none → admin pun ditolak sebelum relay.
  const connAll = fakeConn()
  await swgcHandler(baseM(connAll), { conn: connAll, text: 'halo', chat: { swgc: 'all' }, isAdmin: false })
  assert.equal(connAll.calls.relay.length, 1)
  const connNone = fakeConn()
  await assert.rejects(swgcHandler(baseM(connNone), { conn: connNone, text: 'halo', chat: { swgc: 'none' }, isAdmin: true }), /dimatikan di grup ini/)
  assert.equal(connNone.calls.relay.length, 0)
})

test('group: flag grup + admin, perintah tunggal group', () => {
  assert.equal(groupHandler.group, true)
  assert.equal(groupHandler.admin, true)
  assert.deepEqual(groupHandler.command, ['group'])
})

test('group: parseGroupSet — show, set sah, dan penolakan yang jelas', () => {
  assert.deepEqual(parseGroupSet([]), { show: true })
  assert.deepEqual(parseGroupSet(['set', 'swgc', 'ALL']), { key: 'swgc', value: 'all' })
  assert.deepEqual(parseGroupSet(['set', 'swgc', 'none']), { key: 'swgc', value: 'none' })
  assert.throws(() => parseGroupSet(['ubah']), /Formatnya:/)
  assert.throws(() => parseGroupSet(['set']), /wajib diisi/)
  assert.throws(() => parseGroupSet(['set', 'welcome', 'all']), /tidak dikenal/)
  assert.throws(() => parseGroupSet(['set', 'swgc', 'xyz']), /Nilai buat swgc/)
  assert.throws(() => parseGroupSet(['set', 'swgc']), /Nilai buat swgc/)
})

test('group: handler set menulis chats.swgc + save; handler polos menampilkan mode berjalan', async t => {
  const record = { swgc: 'admin' }
  const saved = []
  const savedDb = globalThis.db
  globalThis.db = { ensure: () => record, save: async c => { saved.push(c) } }
  t.after(() => { if (savedDb === undefined) delete globalThis.db; else globalThis.db = savedDb })
  const conn = fakeConn()
  const m = baseM(conn)
  await groupHandler(m, { chat: record, args: ['set', 'swgc', 'all'] })
  assert.equal(record.swgc, 'all')
  assert.deepEqual(saved, ['chats'])
  assert.match(m.replies[0], /\*all\*/)
  const m2 = baseM(conn)
  await groupHandler(m2, { chat: { swgc: 'none' }, args: [] })
  assert.match(m2.replies[0], /Mode .swgc grup ini sekarang: \*none\*/)
})
