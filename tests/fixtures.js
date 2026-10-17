import { EventEmitter } from 'node:events'
import { proto } from '@whiskeysockets/baileys'
import { decorateSocket, serialize } from '../lib/simple.js'
import { createStore } from '../lib/store.js'
import { OutboundQueue } from '../lib/helpers/queue.js'
export const PN = '6281234567890@s.whatsapp.net', LID = '10001@lid', BOTPN = '6282234567890@s.whatsapp.net', BOTLID = '20002@lid', GROUP = '123456789@g.us'
export function raw(text = '.ping', { group = false, fromMe = false, id = 'msg1', timestamp = Date.now() / 1000, alt = true, message } = {}) {
  const m = proto.WebMessageInfo.fromObject({ key: { id, remoteJid: group ? GROUP : PN, fromMe, ...(group ? { participant: PN } : {}) }, messageTimestamp: timestamp, pushName: 'Test', message: message ?? { conversation: text } })
  if (alt) m.key[group ? 'participantAlt' : 'remoteJidAlt'] = LID
  return m
}
export function fakeConn({ db, roles, store = createStore({ wait: async () => {} }), mapping = true } = {}) {
  serialize(); const calls = []
  const sock = { ev: new EventEmitter(), user: { id: BOTPN, lid: BOTLID }, calls, signalRepository: { lidMapping: { getLIDForPN: async pn => mapping && pn === PN ? LID : null, getPNForLID: async lid => mapping && lid === LID ? PN : null } },
    async sendMessage(jid, data, options) { calls.push({ jid, data, options }); return raw('', { id: 'sent' + calls.length, fromMe: true, message: { conversation: data.text || '' } }) },
    async groupMetadata(id) { calls.push({ metadata: id }); return { id, subject: 'Test group', participants: [{ id: LID, phoneNumber: PN, admin: 'admin' }, { id: BOTLID, phoneNumber: BOTPN, admin: 'admin' }] } },
    async groupParticipantsUpdate(jid, ids, action) { calls.push({ action, ids }); return ids.map(jid => ({ jid, status: '200' })) }, async readMessages(keys) { calls.push({ read: keys }) }, async updateMediaMessage(m) { return m },
  }
  decorateSocket(sock, { db, store, outbound: new OutboundQueue({ perChatMs: 0, perSecond: 10000, jitter: 0 }) }); store.bind(sock); return sock
}
