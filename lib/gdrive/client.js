import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Klien Google Drive v3 berbasis fetch global — port dari subsistem
// legacy (lib/gdrive-auth.js + pemakaian googleapis di
// lib/gdrive-uploader*.js) TANPA dependensi googleapis: OAuth2 cukup
// dengan pertukaran refresh token, dan unggahan memakai protokol
// resumable resmi (sesi -> PUT per potongan dari disk, tidak pernah
// menampung file utuh di RAM).
//
// Kredensial dibaca dari authDir:
//   credentials.json — file OAuth client dari Google Cloud
//                      ("installed" atau "web": client_id + client_secret)
//   token.json       — hasil otorisasi pengguna (memuat refresh_token)
// Kedua file itu RAHASIA: jangan commit (folder src/integrations/
// dipagar .gitignore) dan jangan kirim isinya ke chat.

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

const MIME_BY_EXT = {
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json'
}

export function mimeForName(name = '') {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream'
}

export function resolveAuthDir(rootDir) {
  const custom = String(globalThis.gdriveAuthDir || '').trim()
  if (custom) return path.isAbsolute(custom) ? custom : path.join(rootDir, custom)
  return path.join(rootDir, 'src', 'integrations', 'gdrive-auth')
}

export function createDriveClient({ authDir, fetchFn = fetch, chunkBytes = 8 * 1024 * 1024 } = {}) {
  if (!authDir) throw new Error('authDir Drive belum diatur.')
  let creds = null
  let tokenCache = null // { accessToken, expiresAt }

  function loadCreds() {
    if (creds) return creds
    let rawCreds, rawToken
    try { rawCreds = JSON.parse(fs.readFileSync(path.join(authDir, 'credentials.json'), 'utf8')) }
    catch { throw new Error(`credentials.json Drive tidak ditemukan di ${authDir} — fitur Drive belum disambungkan.`) }
    try { rawToken = JSON.parse(fs.readFileSync(path.join(authDir, 'token.json'), 'utf8')) }
    catch { throw new Error(`token.json Drive tidak ditemukan di ${authDir} — fitur Drive belum disambungkan.`) }
    const box = rawCreds.installed || rawCreds.web || {}
    if (!box.client_id || !box.client_secret) throw new Error('credentials.json Drive tidak memuat client_id/client_secret.')
    if (!rawToken.refresh_token) throw new Error('token.json Drive tidak memuat refresh_token.')
    creds = { clientId: box.client_id, clientSecret: box.client_secret, refreshToken: rawToken.refresh_token }
    return creds
  }

  async function getAccessToken() {
    if (tokenCache && Date.now() < tokenCache.expiresAt - 30_000) return tokenCache.accessToken
    const c = loadCreds()
    const res = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        refresh_token: c.refreshToken,
        grant_type: 'refresh_token'
      })
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.access_token) {
      throw new Error(`Gagal menyegarkan token Drive (HTTP ${res.status})${data.error ? ': ' + data.error : ''}`)
    }
    tokenCache = { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 }
    return tokenCache.accessToken
  }

  async function api(pathname, { method = 'GET', body, params } = {}) {
    const token = await getAccessToken()
    const url = new URL(API + pathname)
    url.searchParams.set('supportsAllDrives', 'true')
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    const res = await fetchFn(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`Drive API ${method} ${pathname} gagal (HTTP ${res.status})${data.error?.message ? ': ' + data.error.message : ''}`)
    return data
  }

  const escapeQ = name => String(name).replace(/'/g, "\\'")

  async function findChildByName(name, parentId, { folderOnly = false } = {}) {
    const q = [
      `name='${escapeQ(name)}'`,
      `'${parentId}' in parents`,
      'trashed=false',
      ...(folderOnly ? [`mimeType='${FOLDER_MIME}'`] : [])
    ].join(' and ')
    const data = await api('/files', { params: { q, fields: 'files(id,name,mimeType)', includeItemsFromAllDrives: 'true', pageSize: '1' } })
    return data.files?.[0] || null
  }

  async function getFileMeta(fileId, fields = 'id,name,mimeType,size,webViewLink') {
    return api(`/files/${encodeURIComponent(fileId)}`, { params: { fields } })
  }

  async function createFolder(name, parentId) {
    const data = await api('/files', {
      method: 'POST',
      body: { name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) },
      params: { fields: 'id,name' }
    })
    return data
  }

  async function getOrCreateFolder(name, parentId) {
    const found = await findChildByName(name, parentId, { folderOnly: true })
    if (found) return { id: found.id, created: false }
    const made = await createFolder(name, parentId)
    return { id: made.id, created: true }
  }

  // Unggah resumable per potongan. Mengembalikan metadata file Drive
  // { id, name, size, webViewLink }.
  async function uploadFile(localPath, { name, parentId, size, onProgress } = {}) {
    const token = await getAccessToken()
    const fileName = name || path.basename(localPath)
    const total = typeof size === 'number' ? size : (await fsp.stat(localPath)).size

    const initUrl = new URL(UPLOAD_API + '/files')
    initUrl.searchParams.set('uploadType', 'resumable')
    initUrl.searchParams.set('supportsAllDrives', 'true')
    initUrl.searchParams.set('fields', 'id,name,size,webViewLink')
    const init = await fetchFn(initUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(total),
        'X-Upload-Content-Type': mimeForName(fileName)
      },
      body: JSON.stringify({ name: fileName, ...(parentId ? { parents: [parentId] } : {}) })
    })
    if (!init.ok) throw new Error(`Gagal memulai sesi unggah Drive (HTTP ${init.status}): ${(await init.text().catch(() => '')).slice(0, 200)}`)
    const sessionUrl = init.headers.get('location')
    if (!sessionUrl) throw new Error('Drive tidak mengembalikan URL sesi unggah (header Location kosong).')

    const fh = await fsp.open(localPath, 'r')
    try {
      let offset = 0
      for (;;) {
        if (total === 0) {
          const res = await fetchFn(sessionUrl, { method: 'PUT', headers: { 'Content-Length': '0' } })
          if (res.status === 200 || res.status === 201) return res.json()
          throw new Error(`Unggah file kosong gagal (HTTP ${res.status}).`)
        }
        const len = Math.min(chunkBytes, total - offset)
        const buf = Buffer.alloc(len)
        const { bytesRead } = await fh.read(buf, 0, len, offset)
        const res = await fetchFn(sessionUrl, {
          method: 'PUT',
          headers: {
            'Content-Length': String(bytesRead),
            'Content-Range': `bytes ${offset}-${offset + bytesRead - 1}/${total}`
          },
          body: buf.subarray(0, bytesRead)
        })
        if (res.status === 200 || res.status === 201) {
          onProgress?.(total, total)
          return res.json()
        }
        if (res.status === 308) {
          // Potongan diterima sebagian/seluruhnya; hormati Range server
          // bila dikirim, selain itu lanjut dari yang barusan terkirim.
          const range = res.headers.get('range')
          const confirmed = range ? Number(range.split('-')[1]) + 1 : NaN
          offset = Number.isFinite(confirmed) ? confirmed : offset + bytesRead
          onProgress?.(offset, total)
          continue
        }
        throw new Error(`Unggah Drive gagal di offset ${offset} (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`)
      }
    } finally {
      await fh.close().catch(() => {})
    }
  }

  return { getAccessToken, findChildByName, getFileMeta, createFolder, getOrCreateFolder, uploadFile }
}

// Singleton per proses untuk jalur bot (authDir dihitung dari root bot).
let singleton = null
export function getDriveClient({ rootDir } = {}) {
  if (singleton) return singleton
  const root = rootDir || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  singleton = createDriveClient({ authDir: resolveAuthDir(root) })
  return singleton
}
