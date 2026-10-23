// lib/downloader/engines/pixeldrain.js
//
// Engine murni untuk Pixeldrain: cuma tau cara ambil metadata & cara
// ngunduh filenya. Gak tau apa-apa soal WhatsApp/conn/m.reply — itu kerjaan
// interface controller di plugins/ (plugins/downloader/unduh.js).
//
// Diporting dari konsolidasi legacy lib/downloader/engines/pixeldrain.js
// (gabungan opixeldrain3 + opixeldrain4), ditulis ulang ke fetch global
// (bot ini tidak memakai node-fetch/cheerio), dengan dua perbaikan:
//
//  1. BUG /l/ legacy: item dipilih dengan `files[selectedIndex]` padahal
//     #item= bersifat 1-based — item selalu bergeser satu, item terakhir
//     (dan list isi 1 file) selalu gagal. Di sini `files[selectedIndex - 1]`.
//     Terverifikasi live 2026-10-21 pada list h3motuMK (1 file, 648 MB):
//     #item=1 benar, #item=12 di luar jangkauan.
//  2. /l/ TANPA #item= sekarang mengembalikan daftar isi list
//     ({ isList: true, files: [...] }) supaya controller bisa menampilkan
//     daftarnya ke pengguna, bukan diam-diam mengambil file pertama.
//
// Kontrak engine (sama untuk semua engine): ekspor `id`, `match(url)`,
// `getInfo(url)` dan `download(url, info, { destDir, baseName, maxBytes })`.

import path from 'node:path'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'

export const id = 'pixeldrain'

const ORIGIN = 'https://pixeldrain.com'
const API = `${ORIGIN}/api`
// Timeout info dibuat lega (120 dtk): dari VM ini respons Pixeldrain
// biasanya 1–2 dtk, tapi varians jaringannya besar — pada 2026-10-22
// getInfo /d/ gugur di batas lama 30 dtk ("The operation was aborted
// due to timeout", dilaporkan guardian ke owner). Pola yang sama
// seperti instatiktok: layanan pihak ketiga tidak bisa digeneralisasi
// timeout-nya, jadi engine ini membawa angkanya sendiri.
const INFO_TIMEOUT_MS = 120 * 1000

export function match(url = '') {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    return host === 'pixeldrain.com' || host.endsWith('.pixeldrain.com')
  } catch { return false }
}

function parseItemIndex(url = '') {
  const hash = String(url).split('#')[1] || ''
  const m = hash.match(/item=(\d+)/i)
  return m ? parseInt(m[1], 10) : null
}

export function parsePixeldrainUrl(url = '') {
  const str = String(url).trim()
  const grab = marker => {
    const part = str.split(marker)[1]
    return part ? part.split(/[?#]/)[0] : null
  }
  if (str.includes('/l/')) return { kind: 'list', id: grab('/l/'), itemIndex: parseItemIndex(str) }
  if (str.includes('/u/')) return { kind: 'file', id: grab('/u/'), itemIndex: null }
  if (str.includes('/d/')) return { kind: 'filesystem', id: grab('/d/'), itemIndex: parseItemIndex(str) }
  throw new Error('URL tidak valid untuk Pixeldrain (harus mengandung /u/, /d/, atau /l/).')
}

async function fetchOk(fetchFn, url, opts = {}) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(INFO_TIMEOUT_MS), ...opts })
  if (!res.ok) throw new Error(`HTTP ${res.status} dari ${new URL(url).hostname}`)
  return res
}

/**
 * Ambil metadata TANPA mengunduh body file.
 * - /u/ dan /d/: { fileName, size, fileUrl }
 * - /l/ + #item=N: metadata file ke-N (1-based) + { isList, listId, itemIndex, listSize }
 * - /l/ tanpa #item: { isList: true, fileName: judul list, size: total,
 *                      files: [{ id, fileName, size, mimetype }] } (tanpa fileUrl)
 */
export async function getInfo(url, { fetchFn = fetch } = {}) {
  const { kind, id: pid, itemIndex } = parsePixeldrainUrl(url)
  if (!pid) throw new Error('ID Pixeldrain tidak ditemukan di URL.')

  try {
    if (kind === 'list') {
      const res = await fetchOk(fetchFn, `${API}/list/${pid}`)
      const list = await res.json()
      if (!Array.isArray(list?.files) || list.files.length === 0) {
        throw new Error('List kosong atau format API berubah.')
      }
      const files = list.files.map(f => ({
        id: f.id,
        fileName: f.name || 'unknown.bin',
        size: f.size || 0,
        mimetype: f.mime_type || ''
      }))

      if (itemIndex == null) {
        return {
          isList: true,
          listId: pid,
          fileName: list.title || `pixeldrain-list-${pid}`,
          size: files.reduce((n, f) => n + (f.size || 0), 0),
          files
        }
      }

      if (itemIndex < 1 || itemIndex > files.length) {
        throw new Error(`Item tidak valid. Total item: ${files.length}. Gunakan #item=1 s/d #item=${files.length}`)
      }
      const file = files[itemIndex - 1] // 1-based -> indeks array (bug legacy diperbaiki di sini)
      if (!file?.id) throw new Error('File id tidak ditemukan di list.')
      return {
        isList: true,
        listId: pid,
        itemIndex,
        listSize: files.length,
        fileName: file.fileName,
        size: file.size,
        mimetype: file.mimetype,
        fileUrl: `${API}/file/${file.id}`
      }
    }

    if (kind === 'file') {
      const res = await fetchOk(fetchFn, `${API}/file/${pid}/info`)
      const info = await res.json()
      return {
        fileName: info.name || 'unknown.bin',
        size: info.size || 0,
        mimetype: info.mime_type || '',
        fileUrl: `${API}/file/${pid}`
      }
    }

    // kind === 'filesystem' (/d/): metadata tertanam di HTML sebagai
    // window.initial_node (cara yang sama seperti legacy owner-npd).
    const res = await fetchOk(fetchFn, `${ORIGIN}/d/${pid}`)
    const html = await res.text()
    const m = html.match(/window\.initial_node\s*=\s*(\{.*?\});/s)
    if (!m) throw new Error('initial_node tidak ditemukan — format halaman /d/ berubah.')
    const meta = JSON.parse(m[1])
    let node = meta.path?.[0]
    if (!node) throw new Error('Metadata node kosong di halaman /d/.')

    // Node bisa berupa folder: turun ke file anak sesuai #item (default 1).
    if (Array.isArray(node.children) && node.children.length) {
      const selected = itemIndex ?? 1
      const child = node.children[selected - 1] || node.children[0]
      if (child) node = { ...child, _childId: child.id }
    }

    const fileId = node._childId || pid
    return {
      fileName: node.name || 'unknown.bin',
      size: node.file_size || node.size || 0,
      fileUrl: `${API}/filesystem/${fileId}`
    }
  } catch (err) {
    throw new Error('Gagal mengambil informasi file Pixeldrain: ' + err.message)
  }
}

/**
 * Unduh file ke disk (streaming, tidak dibuffer ke RAM). Nama final
 * ditentukan di sini karena mimetype baru pasti dari header respons.
 */
export async function download(url, info, { destDir, baseName, maxBytes, fetchFn = fetch } = {}) {
  if (!info?.fileUrl) {
    throw new Error('Info ini tidak punya file tunggal (list Pixeldrain tanpa #item=). Pilih item dulu, mis. tambahkan #item=1 di akhir link.')
  }
  const response = await fetchFn(info.fileUrl)
  if (!response.ok) throw new Error(`Gagal mengunduh file (${response.status})`)

  const mimetype = response.headers.get('content-type') || info.mimetype || 'application/octet-stream'
  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)

  const bytes = await streamToFile(response.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}
