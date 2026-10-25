// lib/downloader/engines/gofile.js
//
// Engine murni untuk GoFile (gofile.io). Diadaptasi dari plugin yue-bot
// (plugins/gofile.js, hasil ekstrak SC YUE ARIFURETA 29-09-2026):
// metadata diambil dari API resmi (GET api.gofile.io/contents/<id>)
// dengan header X-Website-Token (WT) yang diturunkan dari token akun,
// dan unduhan memakai header yang sama. Token tamu dibuat dulu
// (POST /accounts) karena WT tidak bisa diturunkan tanpa token —
// berbeda dengan engine lama yang mencoba tanpa token dulu dan memakai
// cookie accountToken saat unduh.
// Folder berisi banyak file mengikuti pola list Pixeldrain: tanpa #item
// dikembalikan daftar isi; #item=<n> (1-based) memilih satu file, dan
// token tamu diteruskan ke download() lewat info untuk header unduhan.
//
// Catatan: WT_SECRET adalah secret token situs web GoFile dari klien web
// (bukan kredensial akun siapa pun) — sama kategorinya dengan konstanta
// WT publik pada engine lama.

import crypto from 'node:crypto'
import path from 'node:path'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'

export const id = 'gofile'

const API = 'https://api.gofile.io'
const UA = 'Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36'
const LANGUAGE = 'en-US'
const WT_SECRET = '12af056dacea0b'
const INFO_TIMEOUT_MS = 30 * 1000

export function match(url = '') {
  try {
    const u = new URL(String(url))
    return (u.hostname === 'gofile.io' || u.hostname === 'www.gofile.io') && /\/d\/[A-Za-z0-9_-]+/.test(u.pathname)
  } catch { return false }
}

export function contentIdOf(url) {
  return String(url).match(/\/d\/([A-Za-z0-9_-]+)/)?.[1] ?? null
}

// WT = sha256(UA::bahasa::token::jendela-waktu-4-jam::secret), heksadesimal.
// nowMs diekspos agar bisa dites deterministik.
export function generateWT(token, nowMs = Date.now()) {
  const timeWindow = Math.floor(nowMs / 1000 / 14400)
  const input = `${UA}::${LANGUAGE}::${token}::${timeWindow}::${WT_SECRET}`
  return crypto.createHash('sha256').update(input).digest('hex')
}

async function createGuestAccount(fetchFn) {
  const res = await fetchFn(`${API}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
  })
  const json = await res.json().catch(() => null)
  const token = json?.data?.token ?? null
  if (!res.ok || !token) throw new Error(`Gagal mendapatkan token tamu GoFile (${res.status}).`)
  return token
}

async function fetchContents(fetchFn, contentId, token) {
  const params = new URLSearchParams({
    page: '1',
    pageSize: '1000',
    sortField: 'name',
    sortDirection: '1',
  })
  const res = await fetchFn(`${API}/contents/${encodeURIComponent(contentId)}?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Website-Token': generateWT(token),
      'X-BL': LANGUAGE,
      'User-Agent': UA,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GoFile API merespons status ${res.status}.`)
  const json = await res.json().catch(() => null)
  if (json?.status !== 'ok') throw new Error(`GoFile menolak konten (${json?.status ?? 'tanpa status'}).`)
  return json.data
}

export function parseContents(data) {
  if (!data) throw new Error('Respons GoFile kosong.')
  let files = []
  if (data.children && typeof data.children === 'object') {
    const ids = Array.isArray(data.childrenIds) && data.childrenIds.length ? data.childrenIds : Object.keys(data.children)
    files = ids.map(cid => data.children[cid]).filter(c => c && c.type === 'file')
  } else if (data.type === 'file') {
    files = [data]
  }
  if (!files.length) throw new Error('File tidak ditemukan di GoFile (mungkin folder kosong atau link sudah mati).')
  return { files, folderName: data.name || 'Folder GoFile' }
}

export async function getInfo(url, { fetchFn = fetch } = {}) {
  const contentId = contentIdOf(url)
  if (!contentId) throw new Error('Content ID GoFile tidak ditemukan di URL.')
  const token = await createGuestAccount(fetchFn)
  const data = await fetchContents(fetchFn, contentId, token)
  const { files, folderName } = parseContents(data)

  const itemMatch = String(url).match(/#item=(\d+)/)
  if (files.length > 1 && !itemMatch) {
    return {
      isList: true,
      fileName: folderName,
      size: files.reduce((n, f) => n + (f.size || 0), 0),
      files: files.map(f => ({ fileName: f.name, size: f.size ?? null })),
    }
  }
  const index = itemMatch ? Number(itemMatch[1]) - 1 : 0
  const file = files[index]
  if (!file) throw new Error(`Item tidak valid. Total item: ${files.length}`)
  return {
    fileName: file.name,
    size: file.size ?? null,
    mimetype: file.mimetype || null,
    createTime: file.createTime ?? null,
    downloadUrl: file.link,
    token,
    ...(files.length > 1 ? { isList: true, itemIndex: index + 1, listSize: files.length } : {}),
  }
}

export async function download(url, info, { destDir, baseName, maxBytes, fetchFn = fetch } = {}) {
  if (!info?.downloadUrl) throw new Error('Info GoFile tidak membawa link unduhan.')
  // Token dari getInfo dipakai ulang; info lama tanpa token membuat token baru.
  const token = info.token ?? await createGuestAccount(fetchFn)
  const response = await fetchFn(info.downloadUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Website-Token': generateWT(token),
      'X-BL': LANGUAGE,
      'User-Agent': UA,
      Referer: 'https://gofile.io/',
      Accept: '*/*',
    },
  })
  if (!response.ok) throw new Error(`Gagal mengunduh file (${response.status})`)
  const mimetype = response.headers.get('content-type') || info.mimetype || 'application/octet-stream'
  if (mimetype.toLowerCase().includes('text/html')) throw new Error('GoFile mengirim HTML, bukan file.')
  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)
  const bytes = await streamToFile(response.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}
