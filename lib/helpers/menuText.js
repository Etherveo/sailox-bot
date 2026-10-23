// Pembangun teks menu — penerus lib/menulox.js legacy, disesuaikan ke engine
// sekarang: isi menu SELALU dinamis dari registry plugin yang benar-benar
// terpasang (bukan daftar kategori tetap seperti legacy), tanpa dependensi
// eksternal (pengganti moment-timezone: Intl bawaan Node).
//
// Dua halaman seperti legacy:
// - Tanpa argumen / argumen tak dikenal / "list" -> halaman Quick Navigation
//   berisi kategori bernomor.
// - Argumen nama kategori, alias (grup, alat, unduh, ...), atau NOMOR urut
//   navigasi -> halaman kategori itu: sapaan berdasar jam, read-more agar
//   pesan terlipat, lalu daftar perintah berprefix.
//
// Fungsi-fungsi di sini murni (semua konteks diinjeksi lewat parameter)
// supaya bisa dites tanpa koneksi WhatsApp.
const TAG_LABELS = {
  main: 'Main', owner: 'Owner', info: 'Info', tools: 'Tools', group: 'Group',
  jadibot: 'JadiBot', downloader: 'Downloader', maker: 'Maker', anime: 'Anime',
  fun: 'Fun', game: 'Game', rpg: 'RPG', sticker: 'Sticker', ai: 'AI',
  internet: 'Internet', premium: 'Premium', random: 'Random', quotes: 'Quotes',
  nsfw: 'NSFW', audio: 'Audio', store: 'Store', user: 'User', users: 'Users',
  prefixless: 'Tanpa Prefix', misc: 'Lainnya',
}
const TAG_ALIASES = {
  grup: 'group', alat: 'tools', unduh: 'downloader', unduhan: 'downloader',
  download: 'downloader', own: 'owner', stiker: 'sticker', wibu: 'anime',
  gem: 'game', vip: 'premium', sange: 'nsfw', birahi: 'nsfw',
}
const labelOf = tag => TAG_LABELS[tag] ?? (tag.charAt(0).toUpperCase() + tag.slice(1))

// Kelompokkan help plugin per tag. Mengembalikan Map<tag, string[]> dengan
// perintah unik terurut alfabetis — tampilan stabil di setiap render.
export function groupPluginHelp(plugins) {
  const grouped = new Map()
  for (const plugin of plugins ?? []) {
    if (!plugin || plugin.disabled) continue
    const help = (Array.isArray(plugin.help) ? plugin.help : [plugin.help]).filter(h => typeof h === 'string' && h.trim())
    if (!help.length) continue
    const tags = (Array.isArray(plugin.tags) ? plugin.tags : [plugin.tags]).filter(Boolean)
    for (const tag of tags.length ? tags : ['misc']) {
      const key = String(tag).toLowerCase()
      grouped.set(key, [...new Set([...(grouped.get(key) ?? []), ...help])].sort((a, b) => a.localeCompare(b)))
    }
  }
  return grouped
}

// Urutan kategori di navigasi: main selalu pertama, misc terakhir,
// sisanya alfabetis berdasar label tampil.
export function orderCategories(grouped) {
  return [...grouped.keys()].sort((a, b) => {
    const rank = t => t === 'main' ? 0 : t === 'misc' ? 2 : 1
    return rank(a) - rank(b) || labelOf(a).localeCompare(labelOf(b))
  })
}

// Resolusi input pengguna -> tag kategori valid, atau null (tampilkan navigasi).
export function resolveCategory(input, orderedTags) {
  const raw = String(input ?? '').trim().toLowerCase()
  if (!raw || raw === 'list') return null
  if (/^\d+$/.test(raw)) return orderedTags[Number(raw) - 1] ?? null
  const tag = TAG_ALIASES[raw] ?? raw
  return orderedTags.includes(tag) ? tag : null
}

// Sapaan berdasar jam di timezone bot — kalimat sama seperti legacy.
export function greetingFor(now = new Date(), timezone = 'Asia/Jakarta') {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(now))
  return hour >= 18 ? 'Malam, kak' : hour >= 15 ? 'Sore, kak' : hour >= 10 ? 'Siang, kak' : hour >= 4 ? 'Pagi, kak' : 'Udah boleh tidur, kak'
}

export function formatUptime(totalSec = 0) {
  const s = Math.max(0, Math.floor(totalSec))
  const j = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), d = s % 60
  return j ? `${j}j ${m}m` : m ? `${m}m ${d}d` : `${d}d`
}

const READ_MORE = String.fromCharCode(8206).repeat(4001)

export function buildMenuText({ plugins, input = '', prefix = '.', namebot = 'Sailox', userName = '', now = new Date(), timezone = 'Asia/Jakarta', uptimeSec = 0, hideOwner = false } = {}) {
  const grouped = groupPluginHelp(plugins)
  // Kategori owner disembunyikan total (navigasi, nomor urut, halaman "all",
  // dan resolusi kategori) untuk pemanggil selain owner/founder.
  if (hideOwner) grouped.delete('owner')
  const ordered = orderCategories(grouped)
  const greet = greetingFor(now, timezone)
  const name = String(userName ?? '').trim()
  const header = `┈╌──┄── \`⌜ ${namebot} ⌟\` ──┄──╌┈`
  const sapaan = `*${greet}${name ? ` ${name}` : ''}* 👋\nHari ini mau ngapain?`
  const section = t => [
    ` ❆─❲ _*${labelOf(t).toUpperCase()}*_ ❳`,
    ...(grouped.get(t) ?? []).map(c => `• ❳ ${prefix}${c}`),
    '╾─͙─͙─͙─͙─͙▢',
  ].join('\n')

  if (String(input ?? '').trim().toLowerCase() === 'all') {
    return [
      header,
      '',
      sapaan,
      '',
      `*Expand →* ${READ_MORE}`,
      '',
      ordered.map(section).join('\n\n'),
      '',
      `Ketik ${prefix}menu untuk kembali ke navigasi`,
    ].join('\n')
  }

  const tag = resolveCategory(input, ordered)

  if (!tag) {
    const total = [...grouped.values()].reduce((n, cmds) => n + cmds.length, 0)
    const nav = ordered.map((t, i) => `${i + 1}. ${labelOf(t)} — ${grouped.get(t).length} perintah`)
    const lines = [
      header,
      '',
      sapaan,
      '',
      '🐢 「Quick Navigation」 🐢',
      `Prefix: ${prefix} • Total: ${total} perintah • Aktif: ${formatUptime(uptimeSec)}`,
      '',
      ...nav,
      '',
      `Ketik *${prefix}menu <kategori>*, *${prefix}menu <nomor>*, atau *${prefix}menu all*`,
    ]
    if (ordered.length) lines.push(`Contoh: ${prefix}menu ${ordered.includes('owner') ? 'owner' : ordered[0]}`)
    lines.push('', `> Simple Navigation by ${namebot}`)
    return lines.join('\n')
  }

  return [
    header,
    '',
    sapaan,
    '',
    `*Expand →* ${READ_MORE}`,
    '',
    section(tag),
    `Ketik ${prefix}menu untuk kembali ke navigasi`,
  ].join('\n')
}
