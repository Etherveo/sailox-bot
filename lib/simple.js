import baileys, { proto, normalizeMessageContent, extractMessageContent, getContentType, jidDecode, jidNormalizedUser, downloadMediaMessage } from '@whiskeysockets/baileys'
import { fileTypeFromBuffer } from 'file-type'
import { parsePhoneNumber } from 'awesome-phonenumber'
import fs from 'node:fs/promises'
import path from 'node:path'
import { sandboxPath } from './subbot/sandbox.js'
import { randomUUID, randomInt } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { messageState } from './helpers/messageState.js'
import { duration } from './helpers/time.js'
import { OutboundQueue } from './helpers/queue.js'
import { fetchPublicBuffer } from './helpers/net.js'
import { splitText } from './helpers/text.js'
import { silentLogger } from './helpers/silentLogger.js'
import { logger } from './print.js'
import { normalize, kind, createIdentity } from './identity/resolver.js'
const maxMedia = 20 * 1024 * 1024
const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage']
let prototyped = false, serialized = false
export function protoType() {
  if (prototyped) return; prototyped = true
  Object.defineProperties(Buffer.prototype, { toArrayBuffer: { value() { return this.buffer.slice(this.byteOffset, this.byteOffset + this.byteLength) } } })
  Object.defineProperties(ArrayBuffer.prototype, { toBuffer: { value() { return Buffer.from(this) } } })
  for (const target of [Uint8Array.prototype, ArrayBuffer.prototype, Buffer.prototype]) Object.defineProperties(target, { getFileType: { value() { return fileTypeFromBuffer(Buffer.from(this instanceof ArrayBuffer ? this : this.buffer, this.byteOffset ?? 0, this.byteLength)) } } })
  for (const target of [String.prototype, Number.prototype]) Object.defineProperties(target, { isNumber: { value() { return String(this).trim() !== '' && Number.isFinite(Number(this)) } } })
  Object.defineProperties(String.prototype, { capitalize: { value() { return String(this).replace(/^./u, c => c.toUpperCase()) } }, capitalizeV2: { value() { return String(this).replace(/\b\p{L}/gu, c => c.toUpperCase()) } }, decodeJid: { value() { return normalize(String(this)) ?? String(this) } } })
  Object.defineProperties(Number.prototype, { toTimeString: { value() { return duration(this) } } })
  for (const target of [Number.prototype, String.prototype, Array.prototype]) Object.defineProperties(target, { getRandom: { value() { const n = typeof this.valueOf() === 'number' ? Math.floor(Number(this)) : this.length; return n > 0 ? typeof this.valueOf() === 'number' ? randomInt(n) : this[randomInt(n)] : undefined } } })
}
function content(m) { return extractMessageContent(normalizeMessageContent(m.message)) ?? {} }
function context(m) { return m.msg?.contextInfo ?? {} }
function quoted(m) {
  const state = messageState(m)
  if (Object.hasOwn(state, 'quoted')) return state.quoted
  const c = context(m)
  if (!c.quotedMessage) return state.quoted = null
  const q = smsg(m.conn, proto.WebMessageInfo.fromObject({ key: { id: c.stanzaId, remoteJid: m.key.remoteJid, participant: c.participant, fromMe: m.conn.identity?.self.some(i => m.conn.identity.same(i, c.participant)) ?? false }, message: c.quotedMessage }))
  Object.defineProperties(q, { vM: { get() { return this } }, fakeObj: { get() { return this } } })
  return state.quoted = q
}
export function serialize() {
  if (serialized) return; serialized = true
  Object.defineProperties(proto.WebMessageInfo.prototype, {
    id: { get() { return this.key?.id ?? '' }, enumerable: true },
    isGroup: { get() { return kind(this.key?.remoteJid) === 'group' }, enumerable: true },
    chat: { get() { return messageState(this).chat ?? normalize(this.key?.remoteJid) }, enumerable: true },
    sender: { get() { return messageState(this).sender ?? normalize(this.key?.fromMe ? this.conn?.user?.lid || this.conn?.user?.id : this.key?.participant || this.key?.remoteJid) }, enumerable: true },
    senderJid: { get() { return messageState(this).senderJid ?? this.conn?.identity?.cachedJid(this.sender) ?? (kind(this.sender) === 'pn' ? this.sender : null) }, enumerable: true },
    senderUnresolved: { get() { return messageState(this).senderUnresolved ?? kind(this.sender) !== 'lid' }, enumerable: true },
    fromMe: { get() { return !!this.key?.fromMe }, enumerable: true },
    isBaileys: { get() { return !this.fromMe && !!this.conn?.identity?.isBot(this.sender) }, enumerable: true },
    mtype: { get() { return getContentType(content(this)) ?? null }, enumerable: true },
    msg: { get() { return content(this)[this.mtype] ?? null } },
    mediaMessage: { get() { return mediaTypes.includes(this.mtype) ? this.msg : null } },
    mediaType: { get() { return this.mediaMessage ? this.mtype.replace('Message', '') : null } },
    text: { get() { return messageState(this).text ?? (typeof this.msg === 'string' ? this.msg : this.msg?.text ?? this.msg?.caption ?? this.msg?.selectedDisplayText ?? this.msg?.title ?? '') }, set(v) { messageState(this).text = String(v) }, enumerable: true },
    mentionedJid: { get() { return messageState(this).mentionedJid ?? context(this).mentionedJid ?? [] }, set(v) { messageState(this).mentionedJid = v }, enumerable: true },
    name: { get() { return global.db?.data.users[this.sender]?.name || this.pushName || this.conn?.store?.names.get(this.sender) || (this.senderJid ? parsePhoneNumber('+' + jidDecode(this.senderJid).user).number?.international : '') || 'Pengguna' }, enumerable: true },
    quoted: { get() { return quoted(this) } },
    reply: { value(text, chatId = this.chat, options = {}) { return this.conn.reply(chatId, text, this, options) } },
    download: { value(saveToFile = false) { return this.conn.downloadM(this, this.mediaType, saveToFile) } },
    copy: { value() { const copy = proto.WebMessageInfo.fromObject(proto.WebMessageInfo.toObject(this)); copy.key = { ...this.key }; return smsg(this.conn, copy) } },
    forward: { value(jid, force = false, options = {}) { return this.conn.copyNForward(jid, this, force, options) } },
    delete: { value() { return this.conn.sendMessage(this.key.remoteJid, { delete: this.key }) } },
  })
}
export function smsg(conn, raw) {
  if (!raw) return null
  serialize()
  const m = raw instanceof proto.WebMessageInfo ? raw : proto.WebMessageInfo.fromObject(raw)
  // Preserve alternate identity fields on plain-object fixtures as well.
  if (!(raw instanceof proto.WebMessageInfo) && raw.key) m.key = { ...m.key, ...raw.key }
  Object.defineProperties(m, { conn: { value: conn, writable: true, configurable: true } })
  return m
}
export function decorateSocket(sock, { store, db = global.db, role = 'main', identity, outbound = new OutboundQueue(), canSend = () => true, root = process.cwd() } = {}) {
  const send = sock.sendMessage.bind(sock), participantsUpdate = sock.groupParticipantsUpdate?.bind(sock)
  Object.defineProperties(sock, { store: { value: store }, role: { value: role }, outbound: { value: outbound }, identity: { value: identity ?? createIdentity({ conn: sock, db }) } })
  Object.defineProperties(sock, {
    sendMessage: { configurable: true, value: async function(jid, value, options = {}) {
      if (!canSend()) throw new Error('Koneksi belum terbuka')
      const target = kind(jid) === 'group' ? normalize(jid) : await this.toJid(jid) || normalize(jid)
      if (!target || !['pn', 'lid', 'group'].includes(kind(target))) throw new Error('Target tidak valid')
      const data = { ...value }
      if (data.mentions) data.mentions = await this.identity.forAction(data.mentions, 'mention', { groupMetadata: store?.cachedGroupMetadata(jid) })
      const texts = typeof data.text === 'string' ? splitText(data.text) : [null]
      let sent
      for (const text of texts) sent = await outbound.run(target, async () => { const m = await send(target, text === null ? data : { ...data, text }, options); if (m) store?.push([m]); return m })
      return sent
    } },
    decodeJid: { value(jid) { return normalize(jid) ?? jid } },
    getJid: { value(id) { return this.identity.cachedJid(id) || id } },
    toJid: { value(id, ctx) { return this.identity.toJid(id, ctx) } },
    toLid: { value(id, ctx) { return this.identity.toLid(id, ctx) } },
    getName: { async value(id) { const lid = await this.toLid(id); if (db?.data.users[lid]?.name) return db.data.users[lid].name; const name = store?.names.get(lid || normalize(id)); if (name) return name; if (kind(id) === 'group') return (await store.getGroupMetadata(id)).subject; const jid = await this.toJid(id); return jid ? parsePhoneNumber('+' + jidDecode(jid).user).number?.international || 'Pengguna' : 'Pengguna' } },
    parseMention: { value(text) { return [...String(text).matchAll(/@(\d{5,20})/g)].slice(0, 20).map(([, d]) => this.identity.cachedJid(d + '@lid') || d + '@s.whatsapp.net') } },
    reply: { async value(jid, text, quoted, options = {}) { if (Buffer.isBuffer(text)) return this.sendFile(jid, text, 'file', '', quoted, false, options); return this.sendMessage(jid, { text: String(text), mentions: options.mentions ?? this.parseMention(text), linkPreview: null }, { ...options, quoted }) } },
    getFile: { async value(source, saveToFile = false) {
      let data, res
      if (Buffer.isBuffer(source)) data = source
      else if (typeof source === 'string' && /^https?:\/\//i.test(source)) ({ data, res } = await fetchPublicBuffer(source, { maxBytes: maxMedia }))
      else if (typeof source === 'string' && /^data:[\w/+.-]+;base64,/.test(source)) { if (source.length > maxMedia * 1.4) throw new Error('Berkas terlalu besar'); data = Buffer.from(source.slice(source.indexOf(',') + 1), 'base64') }
      else if (typeof source === 'string') { if (role === 'sub') source = await sandboxPath(root, path.relative(root, path.resolve(source))); const stat = await fs.stat(source); if (stat.size > maxMedia) throw new Error('Berkas terlalu besar'); data = await fs.readFile(source) }
      else throw new Error('Sumber berkas tidak didukung')
      if (data.length > maxMedia) throw new Error('Berkas terlalu besar')
      const { ext = 'bin', mime = 'application/octet-stream' } = await fileTypeFromBuffer(data) ?? {}
      let filename = null
      if (saveToFile) { filename = path.join(root, 'tmp', randomUUID() + '.' + ext); await fs.writeFile(filename, data, { mode: 0o600 }) }
      return { data, res, mime, ext, filename, async delete() { if (filename) { await fs.unlink(filename); filename = null } } }
    } },
    sendFile: { async value(jid, source, filename = 'file', caption = '', quoted, ptt = false, options = {}) { const file = await this.getFile(source); const type = file.ext === 'webp' ? 'sticker' : file.mime.startsWith('image/') ? 'image' : file.mime.startsWith('video/') ? 'video' : file.mime.startsWith('audio/') ? 'audio' : 'document'; return this.sendMessage(jid, { [type]: file.data, mimetype: file.mime, fileName: path.basename(filename).slice(0, 100), caption: String(caption).slice(0, 3500), ...(type === 'audio' ? { ptt } : {}), ...options }, { quoted }) } },
    sendContact: { async value(jid, contacts, quoted, options = {}) { if (!Array.isArray(contacts) || contacts.length > 10) throw new Error('Maksimal 10 kontak'); const cards = []; for (const c of contacts) { const pn = await this.toJid(c[0]); if (!pn) throw new Error('Nomor kontak tidak diketahui'); const n = jidDecode(pn).user, name = String(c[1]).replace(/[\r\n;\\]/g, '').slice(0, 100); cards.push({ displayName: name, vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL;waid=${n}:+${n}\nEND:VCARD` }) } return this.sendMessage(jid, { contacts: { displayName: cards[0]?.displayName ?? 'Kontak', contacts: cards } }, { ...options, quoted }) } },
    sendPoll: { value(jid, name, values, selectableCount = 1) { if (!Array.isArray(values) || values.length < 2 || values.length > 12 || selectableCount < 1 || selectableCount > values.length) throw new Error('Pilihan polling tidak valid'); return this.sendMessage(jid, { poll: { name: String(name).slice(0, 200), values: values.map(v => String(v).slice(0, 100)), selectableCount } }) } },
    sendReact: { value(jid, emoji, key) { return this.sendMessage(jid, { react: { text: emoji, key } }) } },
    editMessage: { value(jid, key, text) { return this.sendMessage(jid, { text, edit: key }) } },
    copyNForward: { value(jid, message, force = false, options = {}) { return this.sendMessage(jid, { forward: message, force }, options) } },
    cMod: { value(jid, message, text = '', sender, options = {}) { const m = smsg(this, message).copy(); if (m.mtype === 'conversation') m.message.conversation = text; else if (m.msg) { if ('caption' in m.msg) m.msg.caption = text; else m.msg.text = text; Object.assign(m.msg, options) } m.key = { ...m.key, remoteJid: jid, ...(sender ? { participant: sender } : {}) }; return m } },
    downloadM: { async value(message, type, saveToFile = false) { if (!mediaTypes.includes(type + 'Message') || !message.mediaMessage) throw new Error('Media tidak didukung'); if (Number(message.mediaMessage.fileLength) > maxMedia) throw new Error('Media terlalu besar'); const stream = await downloadMediaMessage(message, 'stream', { options: { signal: AbortSignal.timeout(30000) } }, { logger: silentLogger, reuploadRequest: this.updateMediaMessage.bind(this) }); const chunks = []; let bytes = 0; try { for await (const chunk of stream) { bytes += chunk.length; if (bytes > maxMedia) throw new Error('Media terlalu besar'); chunks.push(chunk) } } finally { stream.destroy() } const data = Buffer.concat(chunks, bytes); if (!saveToFile) return data; return (await this.getFile(data, true)).filename } },
    loadMessage: { value(id) { return store.loadMessage(id) } },
    pushMessage: { value(messages) { return store.push(messages) } },
    serializeM: { value(raw) { return smsg(this, raw) } },
    chatRead: { value(jid, participant, id) { return outbound.run(jid, () => this.readMessages([{ remoteJid: jid, participant, id }])) } },
    getGroupMetadata: { value(jid) { return store.getGroupMetadata(jid) } },
    groupParticipantsUpdate: { configurable: true, async value(jid, ids, action) { if (!['add', 'remove', 'promote', 'demote'].includes(action)) throw new Error('Aksi tidak valid'); const primary = await this.identity.forAction(ids, action, { groupMetadata: store?.cachedGroupMetadata(jid) }); const result = await outbound.run(jid, () => participantsUpdate(jid, primary, action)); if (global.identity?.actionFallback === false) return result; for (let i = 0; i < result.length; i++) { const r = result[i]; if (String(r.status) === '200') continue; const alt = await this.toLid(r.jid || primary[i]); if (alt && kind(primary[i]) !== 'lid') { const retry = await outbound.run(jid, () => participantsUpdate(jid, [alt], action)); result[i] = retry[0] ?? r } } return result } },
    delay: { value: delay },
    logger: { configurable: true, get() { return logger } },
  })
  return sock
}
export function makeWASocket(connectionOptions, options) { return decorateSocket(baileys(connectionOptions), options) }
