// plugins/main/kdrive-relay.js
//
// Jembatan relay kDrive antar-bot (lihat lib/helpers/kdriveRelay.js).
// Hook `all` menelan pesan protokol KDR1 dari bot pasangan: di sisi
// resolver menjawab REQ/PING, di sisi asing menyelesaikan request yang
// sedang menunggu (yang dikirim .unduh mode stranger).
//
// Perintah founder .relayping mengetes pasangan dari sisi asing:
// PING -> PONG, dilaporkan dengan latensinya.

import { handleRelayIncoming, requestPing, relayPeer } from '#lib/helpers/kdriveRelay.js'

let handler = async (m, { conn }) => {
  const peer = relayPeer()
  if (!peer) {
    throw 'kdrivePeer belum terpasang.\nAtur nomor bot pasangan dulu: .config set kdrivePeer <nomor>\n(di bot ini pasang nomor bot asing; di bot asing pasang nomor bot ini)'
  }
  const started = Date.now()
  try {
    const ms = await requestPing(conn)
    return m.reply(`✅ Relay hidup — bot pasangan ${peer} menjawab PONG dalam ${ms} ms.`)
  } catch (e) {
    return m.reply(`❌ Relay tidak menjawab (${Date.now() - started} ms):\n${e.message}`)
  }
}

handler.help = ['relayping']
handler.tags = ['main']
handler.command = /^relayping$/i
handler.founder = true
handler.all = async (m, { conn }) => { await handleRelayIncoming(conn, m) }

export default handler
