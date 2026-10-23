import fsp from 'node:fs/promises'
import path from 'node:path'

// Registry nama chat & orang untuk Ryn — METADATA SAJA, bukan isi pesan.
//
// Bot sebenarnya sudah tahu banyak nama (pushName pengirim, judul grup dari
// metadata), tapi semuanya cache internal yang gampang hilang. Registry ini
// menyimpannya secara awet di src/private/bridge/chat-registry.json supaya
// Ryn bisa mengidentifikasi "grup X" atau "si Y" di kemudian hari.
//
// Aturan mainnya (disepakati dengan founder):
// - Hanya catat yang PUNYA nama; yang tanpa nama diabaikan.
// - Hanya grup yang bot ikuti dan orang yang muncul berinteraksi dengan bot.
// - Tidak ada isi pesan, tidak ada nomor selain identitas yang memang sudah
//   dipakai bot (PN/LID pengirim).
// - Digerbang saklar bridge yang sama; ukuran dibatasi (cap entri, yang
//   paling lama tidak terlihat dibuang lebih dulu).
// Penulisan di-batch: record() menandai kotor, flush menulis atomik paling
// sering sekali per flushMs.

export const REGISTRY_MAX_CHATS = 200
export const REGISTRY_MAX_PEOPLE = 500
const MAX_NAME = 200
const MAX_CHATS_PER_PERSON = 20

export function createChatRegistry({ root, now = Date.now, flushMs = 30000 } = {}) {
  const file = path.join(root, 'src', 'private', 'bridge', 'chat-registry.json')
  let data = null, dirty = false, timer = null, loading = null

  async function load() {
    if (data) return data
    if (!loading) {
      loading = (async () => {
        try {
          const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
          if (parsed && typeof parsed === 'object') data = { chats: parsed.chats ?? {}, people: parsed.people ?? {} }
        } catch { /* belum ada file / korup -> mulai kosong */ }
        if (!data) data = { chats: {}, people: {} }
        return data
      })()
    }
    return loading
  }

  function trim(map, max) {
    const entries = Object.entries(map)
    if (entries.length <= max) return
    entries.sort((a, b) => (a[1].lastSeen ?? 0) - (b[1].lastSeen ?? 0))
    for (const [key] of entries.slice(0, entries.length - max)) delete map[key]
  }

  async function flush() {
    if (!data || !dirty) return
    dirty = false
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await fsp.writeFile(tmp, JSON.stringify({ updatedAt: new Date(now()).toISOString(), chats: data.chats, people: data.people }, null, 2))
    await fsp.rename(tmp, file)
  }

  function schedule() {
    if (timer || flushMs <= 0) return
    timer = setTimeout(() => { timer = null; flush().catch(() => {}) }, flushMs)
    timer.unref?.()
  }

  return {
    file,

    async record({ chatId, chatName, chatType, participantsCount, senderId, senderJid, senderName } = {}) {
      const d = await load()
      const at = now()
      let changed = false
      if (chatId && chatName) {
        const prev = d.chats[chatId]
        d.chats[chatId] = {
          id: chatId,
          name: String(chatName).slice(0, MAX_NAME),
          type: chatType ?? prev?.type ?? 'dm',
          ...(participantsCount ? { participants: participantsCount } : prev?.participants ? { participants: prev.participants } : {}),
          lastSeen: at,
        }
        changed = true
      }
      if (senderId && senderName) {
        const prev = d.people[senderId]
        const chats = new Set(prev?.chats ?? [])
        if (chatId) chats.add(chatId)
        d.people[senderId] = {
          id: senderId,
          name: String(senderName).slice(0, MAX_NAME),
          ...(senderJid ? { jid: senderJid } : prev?.jid ? { jid: prev.jid } : {}),
          chats: [...chats].slice(-MAX_CHATS_PER_PERSON),
          lastSeen: at,
        }
        changed = true
      }
      if (changed) {
        trim(d.chats, REGISTRY_MAX_CHATS)
        trim(d.people, REGISTRY_MAX_PEOPLE)
        dirty = true
        schedule()
      }
      return changed
    },

    flushNow: flush,

    async snapshot() {
      const d = await load()
      return JSON.parse(JSON.stringify(d))
    },

    stop() { if (timer) clearTimeout(timer); timer = null },
  }
}
