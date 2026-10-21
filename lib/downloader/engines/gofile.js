// lib/downloader/engines/gofile.js
//
// Engine murni untuk GoFile (gofile.io). Diporting dari legacy
// plugins/downloader-gofile.js: metadata diambil dari API resmi
// (GET api.gofile.io/contents/<id>), konten publik dicoba tanpa token dan
// token tamu dibuat (POST /accounts) hanya bila API menolak (401/403).
// Folder berisi banyak file mengikuti pola list Pixeldrain: tanpa #item
// dikembalikan daftar isi; #item=<n> (1-based) memilih satu file, dan token
// (bila ada) diteruskan ke download() lewat info untuk header Cookie.

import path from 'node:path'
import { buildFileName } from '../mime.js'
import { streamToFile } from '../stream.js'

export const id = 'gofile'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
const WT = '4fd6sg89d7s6' // token web publik, sama seperti legacy
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

async function fetchContents(fetchFn, contentId) {
  const contentsUrl = `https://api.gofile.io/contents/${contentId}?wt=${WT}&cache=true`
  let res = await fetchFn(contentsUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) })
  let token = null
  if (res.status === 401 || res.status === 403) {
    const tokenRes = await fetchFn('https://api.gofile.io/accounts', { method: 'POST', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) })
    const tokenJson = await tokenRes.json().catch(() => null)
    token = tokenJson?.data?.token ?? null
    if (!token) throw new Error('Gagal mendapatkan token GoFile.')
    res = await fetchFn(contentsUrl, { headers: { 'User-Agent': UA, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) })
  }
  if (!res.ok) throw new Error(`GoFile API merespons status ${res.status}.`)
  const json = await res.json()
  return { data: json?.data, token }
}

export function parseContents(data, token) {
  if (!data) throw new Error('Respons GoFile kosong.')
  let files = []
  if (data.children && typeof data.children === 'object') {
    const ids = Array.isArray(data.childrenIds) && data.childrenIds.length ? data.childrenIds : Object.keys(data.children)
    files = ids.map(cid => data.children[cid]).filter(c => c && c.type === 'file')
  } else if (data.type === 'file') {
    files = [data]
  }
  if (!files.length) throw new Error('File tidak ditemukan di GoFile (mungkin folder kosong atau link sudah mati).')
  return { files, folderName: data.name || 'Folder GoFile', token }
}

export async function getInfo(url, { fetchFn = fetch } = {}) {
  const contentId = contentIdOf(url)
  if (!contentId) throw new Error('Content ID GoFile tidak ditemukan di URL.')
  const { data, token } = await fetchContents(fetchFn, contentId)
  const { files, folderName } = parseContents(data, token)

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
  const headers = { 'User-Agent': UA }
  if (info.token) headers.Cookie = `accountToken=${info.token}`
  const response = await fetchFn(info.downloadUrl, { headers })
  if (!response.ok) throw new Error(`Gagal mengunduh file (${response.status})`)
  const mimetype = response.headers.get('content-type') || info.mimetype || 'application/octet-stream'
  const fileName = buildFileName(baseName, { mimetype, fileName: info.fileName })
  const filePath = path.join(destDir, fileName)
  const bytes = await streamToFile(response.body, filePath, { maxBytes })
  return { filePath, fileName, mimetype, size: bytes }
}
