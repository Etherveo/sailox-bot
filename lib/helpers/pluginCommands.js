import fs from 'node:fs/promises'
import { savePluginFile, deletePluginFile, findPluginFile } from '../plugins/files.js'
import { inspectPolicy } from '../subbot/policy.js'
export async function pluginCRUD(m, { conn, args, text, command }) {
  const loader = global.pluginLoader, root = loader.root
  const sv = /^s(?:ave)?p(?:lugin)?$/i
  const dp = /^d(?:el(?:ete)?)?p(?:lugin)?$/i
  const gp = /^g(?:et)?p(?:lugin)?$/i
  const lp = /^l(?:ist)?p(?:lugin)?$/i
  try {
    if (command === 'saveplugin' || command.match(sv)) {
      const name = args[0]
      if (!name) throw 'Gunakan .saveplugin nama sambil membalas kode/lampiran .js.'
      let code = m.quoted?.text || text.slice(name.length).trimStart()
      if (m.quoted?.mediaMessage) { if (m.quoted.mediaType !== 'document' || !m.quoted.msg.fileName?.endsWith('.js')) throw 'Lampiran harus .js'; code = await m.quoted.download() }
      const sub = conn.role === 'sub'
      if (sub && global.bots.allowCustomPlugins === false) throw 'Plugin kustom sub-bot dinonaktifkan operator.'
      if (sub && global.bots.allowCustomPlugins === 'owner-approval') {
        const checked = inspectPolicy(code, { root, allowedPackages: global.bots.allowedPackages })
        if (!global.approvedPlugins?.includes(checked.hash)) {
          const { queueApproval } = await import('../subbot/approval.js')
          const id = await queueApproval(process.cwd(), name, code, m.sender)
          throw `Menunggu persetujuan operator. ID: ${id}`
        }
      }
      const result = await savePluginFile({ root, name, code, loader, maxKB: sub ? global.bots.maxPluginKB : 512, maxPlugins: sub ? global.bots.maxPlugins : Infinity, policy: sub ? c => inspectPolicy(c, { root, allowedPackages: global.bots.allowedPackages }) : undefined })
      await m.reply(`${result.ok ? 'Tersimpan' : 'Reload gagal'}: ${result.id}\n${result.command ?? result.error ?? ''}`)
    } else if (command === 'getplugin' || command.match(gp)) {
      const found = await findPluginFile(root, args[0]); if (!found) throw 'Plugin tidak ditemukan.'
      const stat = await fs.stat(found.file); if (stat.size > 512 * 1024) throw 'Plugin terlalu besar.'
      const data = await fs.readFile(found.file)
      await (data.length <= 3000 ? m.reply(data.toString()) : conn.sendFile(m.chat, data, found.id.split('/').at(-1), '', m, false, { mimetype: 'text/javascript' }))
    } else if (command === 'deleteplugin' || command.match(dp)) {
      await m.reply(`Dihapus: ${await deletePluginFile({ root, name: args[0], loader })}`)
    }
  } catch (e) { if (typeof e === 'string') throw e; throw `Operasi plugin gagal: ${e.message}` }
}