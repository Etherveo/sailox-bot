import path from 'node:path'
import { createChatRegistry } from '#lib/helpers/chatRegistry.js'

// Pencatat registry nama chat & orang untuk Ryn (lihat
// lib/helpers/chatRegistry.js). Plugin tanpa perintah: handler.before-nya
// mengamati pesan yang memang sudah diproses bot dan mencatat METADATA
// nama saja — grup dari judul metadata grup, orang dari pushName pengirim.
// Yang tanpa nama dilewati. Digerbang saklar bridge, dan pesan bot sendiri
// (fromMe) tidak dicatat.

let registry = null
function regFor(ctx) {
  if (!registry) registry = createChatRegistry({ root: path.resolve(ctx.__dirname, '..', '..') })
  return registry
}

let handler = async () => {}
handler.help = []
handler.tags = ['main']

handler.before = async (m, ctx) => {
  try {
    if (globalThis.bridge !== true || m.fromMe || !m.pushName) return false
    const isGroup = !!m.isGroup
    await regFor(ctx).record({
      chatId: m.chat,
      chatName: isGroup ? ctx.groupMetadata?.subject : m.pushName,
      chatType: isGroup ? 'group' : 'dm',
      participantsCount: isGroup ? ctx.groupMetadata?.participants?.length : undefined,
      senderId: m.sender,
      senderJid: m.senderJid ?? undefined,
      senderName: m.pushName,
    })
  } catch { /* registry tidak boleh mengganggu alur pesan */ }
  return false
}

handler.unload = async () => { try { await registry?.flushNow(); registry?.stop() } catch {} }

export default handler
