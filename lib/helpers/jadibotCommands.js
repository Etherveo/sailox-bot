import { phoneDigits } from '../identity/resolver.js'
import { sessionId } from '../subbot/sandbox.js'
export async function jadibotCommand(m, { conn, command, text, args, isOwner }) {
  const manager = global.subBotManager
  if (!manager) throw 'Jadibot tidak tersedia.'
  if (command === 'jadibot') {
    const number = phoneDigits(text); if (!number) throw 'Gunakan .jadibot <nomor WhatsApp sendiri>.'
    const id = await manager.create(number, { lid: conn.identity.kind(m.sender) === 'lid' ? m.sender : '', jid: m.senderJid, name: m.name }, { isOwner })
    await m.reply(`Sesi ${id} disiapkan. Tunggu kode pairing di chat pribadi ini.`)
  } else if (command === 'listjadibot') {
    const list = manager.registry.list().map(r => { const w = manager.workers.get(r.id); return `${r.id}: ${r.status}; uptime ${w ? Math.floor((Date.now() - r.startedAt) / 1000) : 0}s; RSS ${w ? Math.round((w.rss || 0) / 1048576) : 0} MB; pemilik ${r.ownerLid || r.ownerJid}` })
    await m.reply(list.join('\n') || 'Belum ada sub-bot.')
  } else if (command === 'approveplugin') {
    if (!isOwner) throw 'Khusus owner bot utama.'
    if (args[2] !== 'konfirmasi') throw 'Tinjau kode tertunda di sandbox terlebih dahulu. Gunakan .approveplugin session@nomor requestId konfirmasi'
    await m.reply(`Plugin disetujui: ${await manager.approve(args[0], args[1])}`)
  } else {
    let id = args[0]
    if (id && !id.startsWith('session@')) { const number = phoneDigits(id); if (!number) throw 'Nomor tidak valid.'; id = sessionId(number) }
    id ||= manager.registry.list().find(r => conn.identity.same(r.ownerLid || r.ownerJid, m.sender))?.id
    manager.authorize(id, m.sender, command === 'deljadibot' && isOwner)
    if (command === 'deljadibot') { if (args.at(-1) !== 'konfirmasi') throw `Hapus akan melepas perangkat tertaut dan seluruh data sesi. Kirim .deljadibot ${id} konfirmasi`; await manager.delete(id); await m.reply('Sub-bot dihapus dan perangkat dilepas.') }
    else { await manager.stop(id); await m.reply('Sub-bot dihentikan; data dan sesi disimpan.') }
  }
}
