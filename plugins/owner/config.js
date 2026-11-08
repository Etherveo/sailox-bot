import { CONFIG_REGISTRY, CONFIG_CATEGORIES, listConfig, setConfig, deleteConfig, formatConfigValue, groupConfigRows, resolveConfigCategory } from '#lib/helpers/configStore.js'

// Perintah .config — CRUD konfigurasi runtime khusus founder.
// Create/Update: set (membuat atau menimpa override), Read: list/get,
// Delete: del (menghapus override, nilai kembali ke default config.js).
// Semua perubahan tersimpan ke databases/config.json dan langsung berlaku.
//
// Logika perintah tinggal di sini sejak refactor aturan arsitektur
// 2026-10-28 (sebelumnya lib/helpers/configCommands.js — plugin lama
// hanya pembungkus 7 baris yang meneruskan ke helper).
const USAGE = 'Gunakan:\n.config list [kategori]\n.config get <key>\n.config set <key> <nilai>\n.config del <key>'
const CATEGORY_IDS = CONFIG_CATEGORIES.map(c => c.id).join('|')
const rowLine = r => `• ${r.key} = ${formatConfigValue(r.value)}${r.stored ? ' (json)' : ''}`

export async function configCommand(m, { text }) {
  const db = global.db
  if (!db?.data?.config) throw 'Penyimpanan config belum aktif di proses ini. Restart bot sekali, setelah itu .config bisa dipakai.'
  try {
    const tokens = [...(text ?? '').matchAll(/\S+/g)]
    const sub = (tokens[0]?.[0] ?? 'list').toLowerCase()
    const key = tokens[1]?.[0]
    if (sub === 'list') {
      const rows = listConfig(db)
      const groups = groupConfigRows(rows)
      const wanted = tokens[1]?.[0]
      if (wanted) {
        const catId = resolveConfigCategory(wanted)
        if (!catId) throw `Kategori tidak dikenal: ${wanted}. Pilihan: ${CATEGORY_IDS}`
        const group = groups.find(g => g.id === catId)
        await m.reply(`*Konfigurasi — ${group.label}*\n${group.rows.map(rowLine).join('\n')}\n\n(json) = override tersimpan di databases/config.json; tanpa tanda = nilai config.js.\nSemua kategori: .config list`)
      } else {
        const body = groups.map(g => `*${g.label}*\n${g.rows.map(rowLine).join('\n')}`).join('\n\n')
        await m.reply(`*Konfigurasi runtime*\n\n${body}\n\n(json) = override tersimpan di databases/config.json; tanpa tanda = nilai config.js.\nUbah: .config set <key> <nilai> · Hapus override: .config del <key>\nSatu kategori: .config list <${CATEGORY_IDS}>\nKunci identitas & rahasia (founder/owner/pairing/API) tidak dikelola dari chat.`)
      }
    } else if (sub === 'get') {
      if (!key || !CONFIG_REGISTRY[key]) throw `Kunci tidak dikenal. ${USAGE}`
      const row = listConfig(db).find(r => r.key === key)
      await m.reply(`${key} = ${formatConfigValue(row.value)}\nSumber: ${row.stored ? 'override databases/config.json' : 'default config.js'}\n${row.desc}`)
    } else if (sub === 'set') {
      if (!key || !CONFIG_REGISTRY[key]) throw `Kunci tidak dikenal. ${USAGE}`
      const raw = (text ?? '').slice(tokens[1].index + tokens[1][0].length).trim()
      if (!raw) throw `Nilai kosong. Contoh: .config set ${key} <nilai>`
      const { value, previous } = await setConfig(db, key, raw)
      await m.reply(`Config diubah: ${key}\n${formatConfigValue(previous)} → ${formatConfigValue(value)}\nTersimpan di databases/config.json & langsung berlaku${key === 'hotReloadCore' || key.startsWith('bots.heap') ? ' (untuk proses/worker baru)' : ''}.`)
    } else if (['del', 'delete', 'unset'].includes(sub)) {
      if (!key || !CONFIG_REGISTRY[key]) throw `Kunci tidak dikenal. ${USAGE}`
      const { restored } = await deleteConfig(db, key)
      await m.reply(`Override ${key} dihapus.\nNilai sekarang (dari config.js): ${formatConfigValue(restored)} — langsung berlaku.`)
    } else throw USAGE
  } catch (e) { if (typeof e === 'string') throw e; throw `Operasi config gagal: ${e.message}` }
}

let handler = async (m, ctx) => configCommand(m, ctx)
handler.help = ['config [list|get|set|del] <key> [nilai]'];
handler.tags = ['owner'];
handler.command = ['config', 'cfg'];
handler.founder = true
export default handler
