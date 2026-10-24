// Ambil URL dan kirim isinya ke chat — adaptasi internet-fetch.js &
// internet-fetch2.js legacy (kategori internet; versi -d khusus owner).
// Perbedaan sadar dari legacy:
//   - owner-only: fetch URL bebas dari chat publik rawan disalahgunakan
//     (SSRF ke jaringan internal, sedot bandwidth).
//   - unduhan lewat net.js (fetchPublicBuffer): validasi URL publik +
//     DNS-pinning per-redirect, jadi target IP privat ditolak.
//   - plafon 150 MB (sama dengan maxMedia sendFile) + timeout 60 detik.
import { reactTo, REACT } from '#lib/helpers/react.js'
import { fetchPublicBuffer } from '#lib/helpers/net.js'
import { parseFetchArgs, planFetch } from '#lib/helpers/fetchUrl.js'

const MAX_FETCH_BYTES = 150 * 1024 * 1024

let handler = async (m, { text, conn, usedPrefix, command }) => {
  const { url, forceDoc } = parseFetchArgs(text, { usedPrefix, command })
  await reactTo(m, REACT.processing).catch(() => {})
  try {
    const { data, res } = await fetchPublicBuffer(url.href, {
      maxBytes: MAX_FETCH_BYTES, timeoutMs: 60000, maxRedirects: 10,
    })
    const plan = planFetch({
      url: url.href,
      contentType: res.headers['content-type'] || 'application/octet-stream',
      buffer: data, forceDoc,
    })
    if (plan.kind === 'text') {
      await m.reply(plan.text || '(respons kosong)')
      if (plan.truncated) await conn.sendFile(m.chat, plan.buffer, plan.filename, '', m)
    } else {
      await conn.sendFile(m.chat, plan.buffer, plan.filename, plan.caption, m)
    }
    await reactTo(m, REACT.done).catch(() => {})
  } catch (err) {
    await reactTo(m, REACT.error).catch(() => {})
    throw `❌ Gagal mengambil URL: ${err?.message || err}`
  }
}
handler.help = ['fetch <url>', 'get <url>', 'fetch -d <url> (paksa sebagai dokumen)']
handler.tags = ['tools']
handler.command = /^(fetch|get)$/i
handler.owner = true
export default handler
