import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Helper file-ops global: SATU pintu untuk semua operasi baca/tulis file di
// dalam root project, dipakai plugin mana pun yang butuh akses file supaya
// tidak ada lagi fs.readFileSync/writeFileSync yang tercecer per plugin.
//
//   await ops.fileOp(action, target, opts?)
//
// - action : 'pwd' | 'chdir' | 'list' | 'stat' | 'read' | 'write' | 'append'
//            | 'edit' | 'mkdir' | 'remove' | 'clear' | 'copy' | 'move' | 'search'
// - target : path relatif terhadap cwd virtual (lihat chdir) atau absolut di
//            dalam root; khusus copy/move, angka murni = nomor urut dari
//            daftar list() pada cwd (sama seperti tampilan perintah ls).
// - opts   : parameter fleksibel per action —
//            data      -> isi untuk write/append ("fill"-nya),
//            to        -> tujuan untuk copy/move,
//            find/with -> edit cari-ganti (semua kemunculan),
//            transform -> edit via fungsi (konten lama) => konten baru; inilah
//                         "context param yang mengeksekusi function": helper
//                         yang membaca, menjalankan fungsi itu, lalu menulis
//                         hasilnya, plugin tinggal menyerahkan logikanya,
//            query/ext -> kata kunci & filter ekstensi untuk search.
//
// Semua path dikurung di root project (path jail): '..' atau symlink yang
// keluar root ditolak. Folder sessions/ DITOLAK untuk semua action — isinya
// kredensial akun; membacanya/mengirimnya ke chat sama saja membocorkan akun
// (AGENTS.md 4.2). node_modules/ dan .git/ hanya boleh dibaca, tidak boleh
// ditulis/dihapus/dicari isinya. Root sendiri tidak boleh dihapus/dikosongkan.
//
// Hasil selalu objek terstruktur { ok, action, path, rel, ...payload } dan
// kegagalan dilempar sebagai Error berbahasa Indonesia yang aman ditampilkan
// ke pemanggil (plugin meneruskannya sebagai balasan).
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DENY_ALL = new Set(['sessions'])
const DENY_MUTATE = new Set(['node_modules', '.git'])
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.mp4', '.zip', '.rar', '.7z', '.tar', '.gz', '.pdf', '.exe', '.bin', '.dat', '.db', '.sqlite', '.woff', '.woff2', '.ttf', '.ico'])

export function createFileOps({ root = DEFAULT_ROOT, maxReadBytes = 5 * 1024 * 1024, maxSearchFileBytes = 1024 * 1024, maxSearchFiles = 3000 } = {}) {
  const ROOT = path.resolve(root)
  let cwd = ROOT

  const relOf = abs => { const rel = path.relative(ROOT, abs); return rel === '' ? '.' : rel }
  const firstSegment = abs => relOf(abs).split(path.sep)[0]

  // Resolusi path + penegakan jail. Mengembalikan path absolut yang aman.
  async function resolve(target, { base = cwd, mutate = false } = {}) {
    if (typeof target !== 'string' || !target.trim()) throw new Error('Path kosong.')
    const abs = path.resolve(base, target.trim())
    const rel = path.relative(ROOT, abs)
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error(`Path di luar root project ditolak: ${target}`)
    const seg = firstSegment(abs)
    if (DENY_ALL.has(seg)) throw new Error('Folder sessions/ tidak bisa diakses lewat perintah file (keamanan akun).')
    if (mutate && DENY_MUTATE.has(seg)) throw new Error(`Folder ${seg}/ tidak boleh diubah lewat perintah file.`)
    // Symlink yang menembus keluar root ikut ditolak (cek realpath target yang
    // sudah ada; untuk target baru, cek realpath leluhur terdekatnya).
    let probe = abs
    for (;;) {
      try {
        const real = await fs.realpath(probe)
        const rrel = path.relative(ROOT, real)
        if (rrel === '..' || rrel.startsWith('..' + path.sep) || path.isAbsolute(rrel)) throw new Error(`Path menembus keluar root project (symlink): ${target}`)
        if (DENY_ALL.has(rrel.split(path.sep)[0])) throw new Error('Folder sessions/ tidak bisa diakses lewat perintah file (keamanan akun).')
        break
      } catch (e) {
        if (e?.code !== 'ENOENT') throw e
        const parent = path.dirname(probe)
        if (parent === probe) break
        probe = parent
      }
    }
    return abs
  }

  async function statOf(abs) {
    try {
      const st = await fs.stat(abs)
      return { exists: true, type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.size, mtimeMs: st.mtimeMs }
    } catch (e) {
      if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return { exists: false, type: null, size: 0, mtimeMs: 0 }
      throw e
    }
  }

  // Daftar isi direktori dengan urutan kanonis: folder dulu, lalu file,
  // masing-masing alfabetis. Urutan ini yang dipakai ls DAN resolusi index.
  async function listDir(abs) {
    const st = await statOf(abs)
    if (!st.exists) throw new Error(`Tidak ditemukan: ${relOf(abs)}`)
    if (st.type !== 'dir') throw new Error(`Bukan direktori: ${relOf(abs)}`)
    const names = await fs.readdir(abs)
    const entries = []
    for (const name of names) {
      const s = await statOf(path.join(abs, name))
      entries.push({ name, type: s.type ?? 'other', size: s.size, mtimeMs: s.mtimeMs })
    }
    const rank = e => e.type === 'dir' ? 0 : e.type === 'file' ? 1 : 2
    entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    return entries
  }

  // Target berupa angka murni -> entri ke-N (1-based) dari list(base).
  // Hasilnya tetap dilewatkan resolve() agar cek jail/deny/symlink berlaku
  // sama seperti path biasa (mis. nomor urut folder sessions tetap ditolak).
  async function resolveTarget(target, opts) {
    if (typeof target === 'string' && /^\d+$/.test(target.trim())) {
      const entries = await listDir(opts.base ?? cwd)
      const entry = entries[Number(target.trim()) - 1]
      if (!entry) throw new Error(`Nomor ${target.trim()} tidak ada di daftar direktori ini.`)
      return resolve(path.join(opts.base ?? cwd, entry.name), opts)
    }
    return resolve(target, opts)
  }

  async function fileOp(action, target, opts = {}) {
    switch (action) {
      case 'pwd':
        return { ok: true, action, path: cwd, rel: relOf(cwd) }
      case 'chdir': {
        const abs = await resolve(target ?? '.')
        const st = await statOf(abs)
        if (!st.exists) throw new Error(`Direktori tidak ditemukan: ${target}`)
        if (st.type !== 'dir') throw new Error(`Itu bukan direktori: ${target}`)
        cwd = abs
        return { ok: true, action, path: cwd, rel: relOf(cwd) }
      }
      case 'list': {
        const abs = target ? await resolve(target) : cwd
        const entries = await listDir(abs)
        return { ok: true, action, path: abs, rel: relOf(abs), entries }
      }
      case 'stat': {
        const abs = await resolveTarget(target, {})
        return { ok: true, action, path: abs, rel: relOf(abs), ...await statOf(abs) }
      }
      case 'read': {
        const abs = await resolveTarget(target, {})
        const st = await statOf(abs)
        if (!st.exists) throw new Error(`File tidak ditemukan: ${target}`)
        if (st.type !== 'file') throw new Error(`Target bukan file: ${target}`)
        if (st.size > (opts.maxBytes ?? maxReadBytes)) throw new Error(`File terlalu besar untuk dibaca (${st.size} byte, batas ${opts.maxBytes ?? maxReadBytes}).`)
        const buf = await fs.readFile(abs)
        return { ok: true, action, path: abs, rel: relOf(abs), size: buf.length, data: opts.as === 'text' ? buf.toString('utf8') : buf }
      }
      case 'write': {
        if (opts.data == null) throw new Error('write butuh opts.data (isi file).')
        const abs = await resolve(target, { mutate: true })
        const st = await statOf(abs)
        if (st.exists && !opts.overwrite) throw new Error(`File sudah ada: ${relOf(abs)} (pakai overwrite bila sengaja menimpa).`)
        if (st.type === 'dir') throw new Error(`Target adalah direktori: ${relOf(abs)}`)
        await fs.mkdir(path.dirname(abs), { recursive: true })
        await fs.writeFile(abs, opts.data)
        return { ok: true, action, path: abs, rel: relOf(abs), size: Buffer.byteLength(opts.data) }
      }
      case 'append': {
        if (opts.data == null) throw new Error('append butuh opts.data (isi tambahan).')
        const abs = await resolve(target, { mutate: true })
        const st = await statOf(abs)
        if (st.type === 'dir') throw new Error(`Target adalah direktori: ${relOf(abs)}`)
        await fs.mkdir(path.dirname(abs), { recursive: true })
        await fs.appendFile(abs, opts.data)
        return { ok: true, action, path: abs, rel: relOf(abs), size: (await statOf(abs)).size }
      }
      case 'edit': {
        const abs = await resolveTarget(target, { mutate: true })
        const st = await statOf(abs)
        if (!st.exists || st.type !== 'file') throw new Error(`File tidak ditemukan: ${target}`)
        if (st.size > (opts.maxBytes ?? maxReadBytes)) throw new Error('File terlalu besar untuk diedit.')
        const before = await fs.readFile(abs, 'utf8')
        let after, replacements = null
        if (typeof opts.transform === 'function') {
          const out = await opts.transform(before, { path: abs, rel: relOf(abs) })
          after = typeof out === 'string' ? out : out?.content
          if (typeof after !== 'string') throw new Error('transform harus mengembalikan string (atau { content }).')
        } else if (typeof opts.find === 'string' && opts.find.length) {
          if (!before.includes(opts.find)) throw new Error(`Teks "${opts.find}" tidak ditemukan di file.`)
          replacements = before.split(opts.find).length - 1
          after = before.replaceAll(opts.find, opts.with ?? '')
        } else throw new Error('edit butuh opts.transform (fungsi) atau opts.find + opts.with.')
        if (after === before) return { ok: true, action, path: abs, rel: relOf(abs), replacements: 0, changed: false, sizeBefore: st.size, sizeAfter: st.size }
        await fs.writeFile(abs, after)
        return { ok: true, action, path: abs, rel: relOf(abs), replacements, changed: true, sizeBefore: st.size, sizeAfter: Buffer.byteLength(after) }
      }
      case 'mkdir': {
        const abs = await resolve(target, { mutate: true })
        if ((await statOf(abs)).exists) throw new Error(`Sudah ada: ${relOf(abs)}`)
        await fs.mkdir(abs, { recursive: true })
        return { ok: true, action, path: abs, rel: relOf(abs) }
      }
      case 'remove': {
        const abs = await resolveTarget(target, { mutate: true })
        if (abs === ROOT) throw new Error('Root project tidak boleh dihapus.')
        const st = await statOf(abs)
        if (!st.exists) throw new Error(`Tidak ditemukan: ${target}`)
        await fs.rm(abs, { recursive: true, force: true })
        return { ok: true, action, path: abs, rel: relOf(abs), type: st.type }
      }
      case 'clear': {
        const abs = target ? await resolve(target, { mutate: true }) : cwd
        if (abs === ROOT) throw new Error('Root project tidak boleh dikosongkan.')
        const entries = await listDir(abs)
        for (const e of entries) await fs.rm(path.join(abs, e.name), { recursive: true, force: true })
        return { ok: true, action, path: abs, rel: relOf(abs), removed: entries.length }
      }
      case 'copy': {
        if (!opts.to) throw new Error('copy butuh opts.to (tujuan).')
        const src = await resolveTarget(target, {})
        const st = await statOf(src)
        if (!st.exists) throw new Error(`Sumber tidak ditemukan: ${target}`)
        const dest = await resolve(opts.to, { mutate: true })
        if (dest === src) throw new Error('Tujuan sama dengan sumber.')
        if (st.type === 'dir' && (dest + path.sep).startsWith(src + path.sep)) throw new Error('Tidak bisa menyalin folder ke dalam dirinya sendiri.')
        if ((await statOf(dest)).exists && !opts.overwrite) throw new Error(`Tujuan sudah ada: ${relOf(dest)}`)
        await fs.mkdir(path.dirname(dest), { recursive: true })
        if (st.type === 'dir') await fs.cp(src, dest, { recursive: true, force: !!opts.overwrite })
        else await fs.copyFile(src, dest)
        return { ok: true, action, path: dest, rel: relOf(dest), from: src, fromRel: relOf(src), type: st.type }
      }
      case 'move': {
        if (!opts.to) throw new Error('move butuh opts.to (tujuan).')
        const src = await resolveTarget(target, { mutate: true })
        const st = await statOf(src)
        if (!st.exists) throw new Error(`Sumber tidak ditemukan: ${target}`)
        if (src === ROOT) throw new Error('Root project tidak boleh dipindahkan.')
        const dest = await resolve(opts.to, { mutate: true })
        if (dest === src) throw new Error('Tujuan sama dengan sumber.')
        if (st.type === 'dir' && (dest + path.sep).startsWith(src + path.sep)) throw new Error('Tidak bisa memindahkan folder ke dalam dirinya sendiri.')
        if ((await statOf(dest)).exists) throw new Error(`Tujuan sudah ada: ${relOf(dest)}`)
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.rename(src, dest)
        return { ok: true, action, path: dest, rel: relOf(dest), from: src, fromRel: relOf(src), type: st.type }
      }
      case 'search': {
        const query = String(opts.query ?? '').toLowerCase()
        if (!query) throw new Error('search butuh opts.query (kata kunci).')
        const baseAbs = target ? await resolve(target) : cwd
        if ((await statOf(baseAbs)).type !== 'dir') throw new Error(`Bukan direktori: ${target}`)
        const ext = opts.ext ? String(opts.ext).toLowerCase() : null
        const matches = []
        let scanned = 0
        const walk = async (dir, depth) => {
          if (depth > 12 || scanned >= maxSearchFiles) return
          for (const e of await listDir(dir)) {
            if (scanned >= maxSearchFiles) return
            const full = path.join(dir, e.name)
            const seg = firstSegment(full)
            if (e.type === 'dir') { if (!DENY_ALL.has(seg) && !DENY_MUTATE.has(seg)) await walk(full, depth + 1); continue }
            if (e.type !== 'file') continue
            if (ext && !e.name.toLowerCase().endsWith(ext)) continue
            if (BINARY_EXT.has(path.extname(e.name).toLowerCase())) continue
            if (e.size > maxSearchFileBytes) continue
            scanned++
            let content
            try { content = await fs.readFile(full, 'utf8') } catch { continue }
            const hay = opts.caseSensitive ? content : content.toLowerCase()
            const needle = opts.caseSensitive ? String(opts.query) : query
            if (!hay.includes(needle)) continue
            matches.push({ path: full, rel: relOf(full), count: hay.split(needle).length - 1 })
          }
        }
        await walk(baseAbs, 0)
        return { ok: true, action, path: baseAbs, rel: relOf(baseAbs), matches, scanned }
      }
      default:
        throw new Error(`Action fileOp tidak dikenal: ${action}`)
    }
  }

  return {
    root: ROOT,
    get cwd() { return cwd },
    fileOp,
    resolve: (target, opts) => resolveTarget(target, opts ?? {}),
    rel: relOf,
  }
}

// Instance default terikat root project ini — dipakai plugin-plugin bot utama.
// Tes memakai createFileOps({ root }) sendiri dengan root sementara.
export const fileOps = createFileOps()
export const fileOp = (action, target, opts) => fileOps.fileOp(action, target, opts)
