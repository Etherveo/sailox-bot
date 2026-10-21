import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMenuText, groupPluginHelp, resolveCategory, orderCategories, greetingFor } from '../lib/helpers/menuText.js'
import menuHandler from '../plugins/main/menu.js'

const plugins = [
  { help: ['ping'], tags: ['info'] },
  { help: ['menu [kategori|nomor]'], tags: ['main'] },
  { help: ['ls [path]', 'cd [path]'], tags: ['owner'] },
  { help: ['exec'], tags: ['owner'], disabled: true },
  { help: [], tags: ['owner'] },
  { tags: ['tools'] },
  { help: ['stiker'], tags: ['sticker', 'tools'] },
]
const base = { plugins, prefix: '.', namebot: 'Sailox', userName: 'Veo', timezone: 'Asia/Jakarta', uptimeSec: 3723 }

test('navigasi: kategori bernomor dari plugin yang benar-benar terpasang', () => {
  const text = buildMenuText({ ...base, input: '' })
  assert.match(text, /Quick Navigation/)
  assert.match(text, /1\. Main — 1 perintah/)
  assert.match(text, /Owner — 2 perintah/)
  assert.match(text, /Total: 6 perintah/)
  assert.match(text, /Aktif: 1j 2m/)
  assert.doesNotMatch(text, /exec/, 'plugin disabled tidak boleh tampil')
  assert.match(text, /Contoh: \.menu owner/)
})

test('halaman kategori: sapaan, read-more, perintah berprefix terurut', () => {
  const text = buildMenuText({ ...base, input: 'owner' })
  assert.match(text, /❆─❲ _\*OWNER\*_ ❳/)
  assert.match(text, /• ❳ \.cd \[path\]/)
  assert.match(text, /• ❳ \.ls \[path\]/)
  assert.ok(text.indexOf('.cd') < text.indexOf('.ls'), 'perintah terurut alfabetis')
  assert.ok(text.includes(String.fromCharCode(8206).repeat(4001)), 'ada read-more ala legacy')
  assert.match(text, /kak Veo/)
})

test('nomor & alias menyelesaikan kategori yang sama seperti nama', () => {
  const grouped = groupPluginHelp(plugins)
  const ordered = orderCategories(grouped)
  const ownerIdx = ordered.indexOf('owner') + 1
  assert.equal(resolveCategory(String(ownerIdx), ordered), 'owner')
  assert.equal(resolveCategory('own', ordered), 'owner')
  assert.equal(resolveCategory('OWNER', ordered), 'owner')
  assert.equal(resolveCategory('alat', ordered), 'tools')
  assert.equal(resolveCategory('ngawur', ordered), null)
  assert.equal(resolveCategory('list', ordered), null)
  const byNumber = buildMenuText({ ...base, input: String(ownerIdx) })
  assert.match(byNumber, /_\*OWNER\*_/)
  const byAlias = buildMenuText({ ...base, input: 'alat' })
  assert.match(byAlias, /_\*TOOLS\*_/)
  assert.match(byAlias, /• ❳ \.stiker/, 'plugin multi-tag tampil di tiap kategorinya')
})

test('input tak dikenal jatuh ke navigasi', () => {
  const text = buildMenuText({ ...base, input: 'kategori-ngawur' })
  assert.match(text, /Quick Navigation/)
})

test('sapaan mengikuti jam di timezone bot', () => {
  // Asia/Jakarta = UTC+7
  assert.equal(greetingFor(new Date('2026-10-21T12:00:00Z'), 'Asia/Jakarta'), 'Malam, kak') // 19:00 WIB
  assert.equal(greetingFor(new Date('2026-10-21T04:00:00Z'), 'Asia/Jakarta'), 'Siang, kak') // 11:00 WIB
  assert.equal(greetingFor(new Date('2026-10-20T22:00:00Z'), 'Asia/Jakarta'), 'Pagi, kak') // 05:00 WIB
  assert.equal(greetingFor(new Date('2026-10-21T09:00:00Z'), 'Asia/Jakarta'), 'Sore, kak') // 16:00 WIB
})

test('handler menu memakai registry pluginLoader global', async () => {
  global.pluginLoader = { list: () => plugins.map(plugin => ({ plugin })) }
  try {
    const replies = []
    const m = { name: 'Veo', reply: async teks => { replies.push(String(teks)) } }
    await menuHandler(m, { args: [], usedPrefix: '.' })
    assert.match(replies[0], /Quick Navigation/)
    await menuHandler(m, { args: ['owner'], usedPrefix: '.' })
    assert.match(replies[1], /_\*OWNER\*_/)
  } finally {
    delete global.pluginLoader
  }
})
