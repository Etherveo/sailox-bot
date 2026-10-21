# Aturan Lapisan: Helper vs Engine vs Plugin vs Downloader

Dokumen ini adalah rujukan keputusan saat menambah/menyimpan kode lewat
`.saveplugin` / `.saveengine` atau langsung di disk: **taruh di lapisan yang
benar.** Salah lapisan = kode susah dites, duplikasi, dan fitur yang saling
menabrak.

## Tiga lapisan

### 1. Helper / library — `lib/helpers/`, `lib/downloader/{mime,stream,queue,runJob}.js`

Logika murni atau infrastruktur yang dipakai bersama. Ciri-cirinya:

- Tidak tahu apa-apa soal percakapan WhatsApp: tidak menerima `m`, tidak
  memanggil `conn`, tidak membalas pesan.
- Menerima input terstruktur, mengembalikan hasil terstruktur, melempar
  `Error` berbahasa manusiawi saat gagal.
- Contoh: `fileOps.fileOp()` (semua operasi file), `streamToFile()`
  (streaming unduhan ke disk), `buildMenuText()`, antrean JSON
  `createDownloadQueue()`.

**Naik ke lapisan ini bila:** logika yang sama dibutuhkan ≥2 engine/plugin,
atau logika itu perlu dites tanpa konteks chat.

### 2. Engine — `lib/downloader/engines/<nama>.js`

Satu engine = **satu platform/sumber**, dan hanya itu. Kontrak wajib
(ditegakkan `inspectEngine` + registry saat `.saveengine`):

```js
export const id = 'namaplatform'          // HARUS sama dengan nama file
export function match(url) { /* true hanya untuk URL platform ini (host diperiksa ketat) */ }
export async function getInfo(url, { fetchFn } = {}) { /* metadata CEPAT, tanpa mengunduh body file */ }
export async function download(url, info, { destDir, baseName, maxBytes, fetchFn }) { /* streaming ke destDir */ }
```

Aturan engine:

- **Tidak boleh** menyentuh `conn`, `m`, pesan, antrean, atau izin pengguna.
  Engine hanya menerima URL dan mengembalikan
  `{ fileName, size, mimetype, createTime?, downloadUrl }` (getInfo) dan
  `{ filePath, fileName, mimetype, size }` (download).
- Unduhan **wajib streaming** lewat `streamToFile()` dari
  `lib/downloader/stream.js` — jangan pernah menampung file utuh di buffer
  hanya untuk menuliskannya ke disk.
- `getInfo` harus cepat dan terpisah dari `download`: permukaan (plugin)
  mengirim info ke pengguna SEBELUM unduhan dimulai, karena sebagian
  platform menyampaikan metadata (ukuran, nama, mime, tanggal) bukan lewat
  caption file.
- Daftar/folder multi-file mengikuti pola list: `getInfo` mengembalikan
  `{ isList: true, files: [{ fileName, size }] }` tanpa `fileUrl`, dan
  memilih item lewat `#item=<n>` (1-based) di URL.
- Semua `fetch` menerima injeksi `{ fetchFn }` agar bisa dites dengan
  fixture tanpa jaringan.
- Menambah platform baru = **menambah SATU file engine** (atau
  `.saveengine <nama>` dari chat). Registry memuatnya otomatis (hot-reload)
  dan `.unduh` / `.download` langsung mengenalinya lewat `match()` —
  **jangan** membuat plugin perintah baru per platform.

### 3. Plugin — `plugins/<kategori>/<nama>.js`

Satu plugin = **satu permukaan percakapan** (satu perintah/format chat).
Plugin berisi: parsing input, pemeriksaan izin (`handler.owner` dsb.),
orkestrasi (memanggil helper/engine), dan format balasan.

Aturan plugin:

- **Tidak boleh** berisi logika platform (scraper, API pihak ketiga,
  parsing HTML) — itu wilayah engine/helper. Plugin downloader yang benar
  setipis `plugins/downloader/download.js`: cari link → deteksi provider →
  antrekan → laporkan.
- Tidak boleh menduplikasi infrastruktur: operasi file lewat
  `fileOps.fileOp()`, unduhan lewat engine + `streamToFile()`.
- Dikelola dari chat dengan `.saveplugin` (bukan `.saveengine`).

## Kasus khusus: downloader

Downloader adalah **pola gabungan**: banyak engine (lapisan 2), sedikit
plugin permukaan (lapisan 3):

| Permukaan | Sifat | Antrean | File di disk |
|---|---|---|---|
| `.unduh` / `.u` | Founder, langsung, format `url \| nama custom \| kirimWA 1/0 [-c]` | Tidak | Disimpan di `src/<provider>/`, dihapus hanya dengan `-c` |
| `.download` / `.dl` | Publik | **Ya** — file JSON `src/download-queue.json`, maks 2 berjalan, 1 per pengguna aktif, 3 menunggu per pengguna | Dihapus setelah berhasil terkirim ke WA; dipertahankan (dijaporkan jalurnya) bila gagal/terlalu besar |

Aturan antrean `.dl`:

- State antrean hidup di file JSON, **bukan RAM**: ditulis atomik setiap
  perubahan status; job `active` yatim (bot mati di tengah unduhan)
  dikembalikan ke `pending` dan diunduh ulang dari awal saat antrean
  berjalan lagi.
- Info file dikirim prosesor (`lib/downloader/runJob.js`) SEBELUM unduhan
  dimulai — jangan menahan metadata menunggu file selesai.
- Batas ukuran unduhan 2 GiB (streaming, ditegakkan `streamToFile`);
  pengiriman ke WA berplafon 20 MB (`conn.sendFile`), file lebih besar
  hanya disimpan ke disk dan dilaporkan.

## Penjaga engine (guardian)

`lib/downloader/guardian.js` mengawasi kesehatan engine dari sisi laporan:

- Setiap kegagalan engine — fase `load` (registry gagal memuat file),
  `getInfo`, atau `download` (dari `.unduh` maupun antrean `.dl`) —
  dilaporkan **langsung ke nomor founder** (nomor pertama `global.founder`,
  fallback `global.owner`) lewat pesan WhatsApp.
- Anti-spam: dedupe per (engine, fase) dengan cooldown 30 menit; error
  berulang hanya dihitung dan jumlahnya diselipkan ke laporan berikutnya.
- Laporan sebelum ada koneksi WA (mis. error load saat boot) ditahan
  (maks 10) dan diteruskan saat permukaan downloader berikutnya jalan.
- Penjaga tidak pernah melempar error: kegagalannya sendiri tidak boleh
  mematikan unduhan.

Engine media sosial (tiktok, facebook, instagram, pinterest, twitter)
bersifat **resolver-based**: mereka bergantung pada layanan pihak ketiga
yang sewaktu-waktu bisa berubah atau mati — justru karena itu penjaga
penting: kerusakan ketahuan dari laporan owner, bukan dari keluhan
pengguna. Bila sebuah resolver mati permanen, perbaiki/ganti resolver di
dalam engine yang sama; kontraknya tidak berubah.

Catatan resolver per platform (keadaan 2026-10-21):
- tiktok/facebook/instagram berbagi SATU resolver bersama,
  `lib/downloader/instatiktok.js` (layanan instatiktok.com, dari legacy
  `downloader-download.js` — versi yang pemilik nyatakan bekerja; engine
  per-platform sebelumnya memakai tikwm/savetik, fbdownloader, dan
  downloadgram yang error di lapangan). Pemilihan tautan mengikuti
  legacy: tiktok = tautan ber-`hdplay` else pertama; facebook = tautan
  terakhir; instagram = semua tautan (multi-file -> list).
- pinterest memakai steptodown; twitter memakai vxtwitter dengan API
  legacy sebagai cadangan.

## Pohon keputusan cepat

1. Kode ini tahu soal **satu platform web** (API/scrape/URL-nya)?
   → **Engine.** (`.saveengine`)
2. Kode ini mengatur **percakapan**: parsing perintah, izin, balasan,
   antrean, pengiriman? → **Plugin.** (`.saveplugin`)
3. Kode ini **dipakai bersama** dan tidak tahu soal chat maupun platform
   tertentu? → **Helper/library.**
4. Ragu antara engine dan plugin? Tanya: "kalau platform ini hilang, apakah
   kode ini masih berguna?" Masih berguna → plugin/helper. Ikut hilang →
   engine.

Pelanggaran klasik yang harus ditolak saat review/save:

- Plugin perintah baru khusus satu platform unduhan (harusnya engine).
- Engine yang memanggil `m.reply` / `conn.sendMessage` (harusnya plugin).
- Mengunduh dengan `fetch` → `arrayBuffer()` → tulis file (harusnya
  streaming `streamToFile`).
- Menyimpan state antrean/antrian job hanya di variabel proses (harusnya
  persisten di disk).
