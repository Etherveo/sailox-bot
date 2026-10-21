import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createDriveClient, mimeForName } from '../lib/gdrive/client.js'
import { syncFileToDrive, syncFolderToDrive } from '../lib/gdrive/sync.js'
import { createFileOps } from '../lib/helpers/fileOps.js'
import uptodrive, { formatListing } from '../plugins/owner/uptodrive.js'

async function tmpDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

// ── Klien Drive: resumable upload per potongan + cache token ────────────────

function fakeFetchFactory(state) {
  return async (url, opts = {}) => {
    const u = String(url)
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      state.tokenCalls++
      return new Response(JSON.stringify({ access_token: 'TOK', expires_in: 3600 }), { status: 200 })
    }
    if (u.includes('uploadType=resumable')) {
      state.initBody = JSON.parse(opts.body)
      state.total = Number(opts.headers['X-Upload-Content-Length'])
      return new Response('', { status: 200, headers: { location: 'https://upload.example/session' } })
    }
    if (u === 'https://upload.example/session') {
      const range = opts.headers['Content-Range'] // bytes a-b/total
      state.ranges.push(range)
      const end = Number(range.match(/-(\d+)\//)[1])
      if (end < state.total - 1) {
        return new Response('', { status: 308, headers: { range: `bytes=0-${end}` } })
      }
      return new Response(JSON.stringify({ id: 'FILE1', name: 'x', webViewLink: 'https://drive.example/FILE1' }), { status: 201 })
    }
    throw new Error('URL tak terduga: ' + u)
  }
}

test('drive client: upload resumable terpotong benar, token di-cache', async t => {
  const authDir = await tmpDir(t, 'sailox-gd-auth-')
  await fs.writeFile(path.join(authDir, 'credentials.json'), JSON.stringify({ installed: { client_id: 'cid', client_secret: 'cs' } }))
  await fs.writeFile(path.join(authDir, 'token.json'), JSON.stringify({ refresh_token: 'rtok' }))
  const work = await tmpDir(t, 'sailox-gd-file-')
  const file = path.join(work, 'video.mp4')
  await fs.writeFile(file, Buffer.alloc(10, 7))

  const state = { tokenCalls: 0, ranges: [], total: 0, initBody: null }
  const client = createDriveClient({ authDir, fetchFn: fakeFetchFactory(state), chunkBytes: 4 })
  const up = await client.uploadFile(file, { name: 'video.mp4', parentId: 'FOLDERX', size: 10 })
  assert.equal(up.id, 'FILE1')
  assert.deepEqual(state.ranges, ['bytes 0-3/10', 'bytes 4-7/10', 'bytes 8-9/10'])
  assert.deepEqual(state.initBody.parents, ['FOLDERX'])

  await client.uploadFile(file, { name: 'video.mp4', parentId: 'FOLDERX', size: 10 })
  assert.equal(state.tokenCalls, 1, 'token kedua harus dari cache')
  assert.equal(mimeForName('a.mkv'), 'video/x-matroska')
})

test('drive client: kredensial hilang -> pesan jelas', async t => {
  const authDir = await tmpDir(t, 'sailox-gd-empty-')
  const client = createDriveClient({ authDir, fetchFn: async () => { throw new Error('tidak boleh dipanggil') } })
  await assert.rejects(() => client.getAccessToken(), /credentials\.json Drive tidak ditemukan/)
})

// ── Sync: duplikat dilewati, folder rekursif ────────────────────────────────

function stubClient({ existing = new Set() } = {}) {
  const calls = []
  return {
    calls,
    async findChildByName(name, parentId) { return existing.has(parentId + '/' + name) ? { id: 'LAMA' } : null },
    async uploadFile(localPath, { name, parentId }) { calls.push({ name, parentId }); return { id: 'ID-' + name, webViewLink: 'https://drive.example/' + name } },
    async getOrCreateFolder(name, parentId) { return { id: 'D-' + name, created: true } }
  }
}

test('sync file: nama sama di tujuan dilewati tanpa upload', async t => {
  const dir = await tmpDir(t, 'sailox-gd-sync-')
  const f = path.join(dir, 'a.txt')
  await fs.writeFile(f, 'halo')
  const client = stubClient({ existing: new Set(['TUJUAN/a.txt']) })
  const res = await syncFileToDrive(client, f, 'TUJUAN')
  assert.equal(res.status, 'skipped')
  assert.equal(client.calls.length, 0)
})

test('sync folder: rekursif, folder Drive per level, hitungan benar', async t => {
  const dir = await tmpDir(t, 'sailox-gd-tree-')
  await fs.mkdir(path.join(dir, 'paket', 'sub'), { recursive: true })
  await fs.writeFile(path.join(dir, 'paket', 'satu.txt'), '1')
  await fs.writeFile(path.join(dir, 'paket', 'sub', 'dua.txt'), '2')
  const client = stubClient()
  const res = await syncFolderToDrive(client, path.join(dir, 'paket'), 'TUJUAN')
  assert.equal(res.uploaded, 2)
  assert.equal(res.skipped, 0)
  assert.equal(res.folderName, 'paket')
  assert.deepEqual(client.calls.map(c => c.name).sort(), ['dua.txt', 'satu.txt'])
  assert.equal(client.calls.find(c => c.name === 'dua.txt').parentId, 'D-sub')
})

// ── Plugin: listing, pilih nomor/nama, tujuan khusus ────────────────────────

test('plugin uptodrive: listing, pilih nama, pilih nomor, folderId khusus', async t => {
  const root = await tmpDir(t, 'sailox-gd-plugin-')
  await fs.writeFile(path.join(root, 'video.mp4'), Buffer.alloc(5))
  await fs.mkdir(path.join(root, 'folderku'))
  await fs.writeFile(path.join(root, 'folderku', 'isi.txt'), 'x')

  const client = stubClient()
  global.fileOps = createFileOps({ root })
  global.uptodriveClient = client
  t.after(() => { delete global.fileOps; delete global.uptodriveClient })

  const m = { chat: 'c', sender: '6282348181097@s.whatsapp.net', replies: [], reply(x) { this.replies.push(String(x)); return Promise.resolve() } }

  await uptodrive(m, { text: '' })
  assert.match(m.replies.at(-1), /video\.mp4/)
  assert.match(m.replies.at(-1), /folderku/)

  await uptodrive(m, { text: 'video.mp4' })
  assert.deepEqual(client.calls.at(-1), { name: 'video.mp4', parentId: '1R_JIYXtZehPubsLVYaAxwsmFUxJf0kuw' })
  assert.match(m.replies.at(-1), /Upload selesai/)

  await uptodrive(m, { text: 'video.mp4 : ABCDEFGHIJ12' })
  assert.equal(client.calls.at(-1).parentId, 'ABCDEFGHIJ12')

  const listing = await global.fileOps.fileOp('list')
  const num = listing.entries.findIndex(e => e.name === 'folderku') + 1
  await uptodrive(m, { text: String(num) })
  assert.equal(client.calls.at(-1).name, 'isi.txt', 'folder terpilih harus tersinkron rekursif')
  assert.match(m.replies.at(-1), /Sinkron folder selesai/)

  assert.equal(uptodrive.tags[0], 'owner')
  assert.equal(uptodrive.owner, true)
  assert.match(formatListing('.', [{ name: 'f', type: 'dir', size: 0 }]), /📁 f/)
})
