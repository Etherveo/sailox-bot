# Aturan Lapisan: Helper vs Engine vs Plugin vs Downloader

Dokumen ini adalah rujukan keputusan saat menambah/menyimpan kode lewat
`.saveplugin` / `.saveengine` atau langsung di disk: **taruh di lapisan yang
benar.** Salah lapisan = kode susah dites, duplikasi, dan fitur yang saling
menabrak.

## Tiga lapisan

### 1. Helper / library — `lib/helpers/`, `lib/downloader/{mime,stream,queue,runJob,processor,driveSync}.js`

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
| `.unduh` / `.u` | Founder, langsung, format `url \| nama custom \| kirimWA 1/0 [-c]` | Tidak | Disimpan di `src/downloads/<provider>/`, dihapus hanya dengan `-c` |
| `.download` / `.dl` | Publik | **Ya** — file JSON `src/download-queue.json`, maks 2 berjalan, 1 per pengguna aktif, 3 menunggu per pengguna | Dihapus setelah berhasil terkirim ke WA; dipertahankan (dijaporkan jalurnya) bila gagal/terlalu besar |
| `.animedownload` / `.adl` | Founder, khusus anime, format `url \| nama custom \| isUpload 1/0` | **Ya** — antrean `.dl` yang sama, job bertanda `options` khusus (lihat bagian `.animedownload` di bawah) | Dihapus setelah terkirim; bila `isUpload=1` dipertahankan sampai upload Drive selesai (sukses/duplikat) — gagal upload = file tidak pernah dihapus |
| `.tiktok` / `.tt` | Publik, interaktif (lihat bawah) | **Ya, klaim manual** — memakai file antrean yang sama, tapi tidak diproses pump `.dl` | Sementara di `src/downloads/tiktok/tt-*`, dihapus setelah terkirim (unduh dulu, baru kirim — lihat bawah) |

Aturan antrean `.dl`:

- State antrean hidup di file JSON, **bukan RAM**: ditulis atomik setiap
  perubahan status; job `active` yatim (bot mati di tengah unduhan)
  dikembalikan ke `pending` dan diunduh ulang dari awal saat antrean
  berjalan lagi.
- Info file dikirim prosesor (`lib/downloader/runJob.js`) SEBELUM unduhan
  dimulai — jangan menahan metadata menunggu file selesai.
- File video hasil unduhan dikirim ke WA sebagai **dokumen**, bukan pesan
  video (opsi `asDocument` di `sendFile`; penanda mimetype + ekstensi).
  Foto tetap image, audio tetap audio; album IG tidak berubah (dokumen
  tidak bisa masuk album) dan `.tt` tidak tersentuh. Pengecualian
  (2026-11-07): video **facebook** dan **instagram** dikirim sebagai
  pesan video inline — kedua provider itu diniatkan untuk ditonton
  langsung (album IG memang selalu inline).
- Batas ukuran unduhan 2 GiB (streaming, ditegakkan `streamToFile`);
  pengiriman ke WA berplafon biasa 150 MB (`conn.sendFile`), file lebih
  besar hanya disimpan ke disk dan dilaporkan — KECUALI lewat Penjaga
  Kirim Besar (di bawah).
- **Penjaga Kirim Besar** (`lib/helpers/sendGuard.js`, sejak 2026-11-06):
  pengiriman SATU file hasil `.dl`/`.unduh` di atas 150 MB bisa berangkat
  dengan reservasi penjaga — perintah founder sampai 1 GB; non-founder
  sampai 500 MB hanya bila mode `bigsend.mode` = `all` DAN server sunyi
  (bawaan mode = `founder`, jadi publik tetap mentok 150 MB). `.getfile`
  (owner, permukaan `owner/getfile.js`) ikut sejak fase 2 di hari yang
  sama: file di atas plafon diminta reservasi dulu, lalu dikirim sebagai
  dokumen dari path hasil resolusi jail `fileOp` — di bawah plafon
  perilakunya tidak berubah. Baris info `.unduh` mempra-cek penjaga
  (`checkBigSend`) sebelum menyatakan bisa/tidaknya file dikirim —
  vonis dari plafon mentah menyesatkan founder (regresi 2026-11-06:
  file 201 MB dibilang "tidak bisa" padahal lolos penjaga), dan
  laporan akhirnya membedakan penolakan penjaga dari kegagalan kirim.
  `sendFile`
  menegakkan: tanpa token reservasi yang sah, >150 MB tetap ditolak.
  Media MASUK (`downloadM`) tidak berubah: tetap 150 MB. Alur batch
  (gofile/media) belum ikut jalur besar. Lensa sistem penjaga memakai
  sinyal yang bermakna sama di semua host: tekanan memori PSI
  (`/proc/pressure/memory`), lantai absolut MemAvailable kecil, dan
  sisa ruang cgroup bila ada — MemAvailable mentah TIDAK dipakai
  sebagai cadangan karena menyesatkan di VM ber-balloon (di VM Muse
  balloon 6,1 GB menekan available ke ±418 MB padahal PSI 0,00).
  Kenop runtime: `.config`
  `bigsend.mode|founderCapMB|userCapMB|founderWaitMin|userWaitMin|commitCapMB|osReserveMB|pressureMaxPct`;
  mode `off` = kill switch. Penanda `src/private/send-guard.json`:
  sisa penanda saat boot berarti proses sebelumnya mati di tengah kirim
  besar -> mode hati-hati 30 menit + laporan ke founder.
- **Retry kirim kelas koneksi** (`lib/helpers/sendRetry.js`, sejak
  2026-11-06): pengiriman file hasil `.dl`/`.unduh`/`.getfile` (dan
  `.pilih` anime lewat `runJob`) yang gagal karena koneksi WA putus di tengah jalan
  diulang SEKALI dari file yang sama di disk — pengirim menunggu
  koneksi `open` lagi (maks 120 detik) dan, untuk file besar, meminta
  reservasi penjaga BARU (token lama sekali pakai). Peminta dikabari
  dengan pesan 🔁 saat pengulangan dimulai. Error non-koneksi tidak
  diulang. Latar: unggahan 978 MB mati karena backoff ±6 detik padahal
  unduhannya selesai utuh (job #29, 2026-11-06).
- Alur anime (`.pilih`, job `linkOnlyIfOversize`) ikut penjaga lewat
  pra-cek `checkBigSend` di `runJob`: penolakan keras (mode/plafon/kelas)
  mempertahankan perilaku lama persis (tidak diunduh, info + link,
  penawaran Drive founder); selain itu file diunduh dan reservasi
  diminta di titik kirim atas nama permukaan `anime/pilih.js`. Job
  simpan-lokal dari penawaran oversize memasang `bigSendSurface: null`:
  kontraknya simpan + Drive, tidak pernah kirim WA. Di `runJob`,
  penjaga adalah dependensi terinjeksi (opsi `bigSend`) supaya alur
  bisa diuji deterministik.
- Job yang selesai (done/failed) atau dibatalkan langsung DIHAPUS dari
  file antrean; yang tersimpan hanya job pending/active plus `seq`.
- Link yang sama tidak boleh diproses dua kali: masih mengantri -> ditolak
  ("sudah ada di antrean #N"); baru keluar dari antrean -> cooldown 1 menit
  sebelum boleh diproses lagi (perbandingan URL persis setelah normalisasi
  `new URL().href`). Untuk pengujian, founder bisa mengosongkan antrean
  + cooldown sekaligus lewat `.clearqueue` / `.cq` (founder-only,
  `plugins/owner/clearqueue.js`): job pending dan klaim manual `.tt`
  dihapus, daftar cooldown dikosongkan, job yang sedang aktif dibiarkan
  dan dilaporkan; nomor urut `seq` tidak direset. Pasangannya,
  `.listqueue` / `.lq` (founder-only, `plugins/owner/listqueue.js`),
  menampilkan seluruh antrean (semua pengguna, bukan hanya peminta seperti
  `.dl antrean`) plus daftar cooldown yang masih hidup; `snapshot()`
  antrean ikut mengekspos `recent` (sudah di-prune) untuk keperluan ini.
- Folder hasil unduhan semua provider ada di `src/downloads/<provider>/`
  (gitignored); folder dipastikan ada lewat helper `lib/helpers/ensureDir.js`.
- Provider Facebook/Instagram/TikTok memakai mode respons senyaman mungkin
  (`QUIET_PROVIDERS` di `runJob.js`): respons pertama selalu react ⏳ di
  pesan peminta; antrean solo -> tidak ada pesan teks sama sekali; antrean
  > 1 -> satu pesan posisi antrean yang dihapus setelah media terkirim;
  setelah terkirim react diganti ✅ (gagal -> ❌ + pesan gagal singkat).

## `.animedownload` dan mapping nama anime

`.animedownload` (alias `.adl` / `.animedl` / `.nimedl`, sejak 2026-11-07)
adalah permukaan founder untuk unduhan anime: provider dibatasi tujuh
(pixeldrain, mediafire, gofile, gdrive, mega, mp4upload, kdrive —
penolakan terjadi di plugin, sebelum antre), SEMUA file dikirim sebagai
dokumen, dan nama file di-resolusi dari mapping nama anime. Job memakai
antrean `.dl` yang sama; kekhususannya dibawa `job.options` (kanal
serializable antrean): `{ animeName, customName, forceDocument,
uploadToDrive, bigSendSurface: 'downloader/animedownload.js' }`, dibaca
`runJob` di titik yang relevan — penamaan sesudah `getInfo`, paksa
dokumen di `sendDownloadFile`, permukaan penjaga, retensi folder job.
Kabel prosesor antrean dipakai bersama `.dl` lewat
`lib/downloader/processor.js` (`ensureJobProcessor`).

Penamaan (`lib/helpers/animeNameMap.js`):

- Prioritas: customName (mapping dilewati total; ekstensi menempel dari
  nama asli) → mapping → nama asli → `file`.
- Store mapping: `src/private/JSONs/anime-map.json` — file JSON mandiri,
  BUKAN koleksi database (engine database hanya memuat koleksi yang
  terdaftar di `lib/database/collections/`); folder `src/private/`
  ter-gitignore, jadi isinya state runtime. Tulis atomik (tmp + rename);
  JSON rusak = error keras, tidak pernah ditimpa diam-diam.
- Perintah pengelola (founder, `plugins/owner/`): `.addmapping` / `.amp`
  (`Key | Title | Season | Subtitle`), `.listmapping`, `.delmapping`,
  `.editmapping` (field kosong = tidak diubah; nilai `-` menghapus
  field opsional), `.editmappingkey`, `.clearmapping` (wajib argumen
  `ya`), dan `.ceknama <nama file mentah>` untuk pratinjau hasil.
  Format + regex perintah adalah porting legacy (`owner-npd` +
  `anime-crud-mapper`) termasuk keunikannya — regex `.amp` memang tidak
  menerima `amap`/`addmap`. Fetch massal MAL/Jikan SENGAJA tidak ada:
  mapping murni manual satu per satu.
- Kecocokan: token nama file (di-uppercase, dibelah `[^A-Z0-9]+`) harus
  memuat seluruh token kunci; kunci terpanjang menang. Nama wajib
  membawa label Episode/OVA/Special/Movie, kalau tidak mapping tidak
  cocok (hasil null, pemanggil jatuh ke nama asli).
- Format nama hasil: tag awalan maksimal satu — `[END]` bila nama asli
  bertanda `END`/`END.` (mengalahkan segalanya); `[NEW]` HANYA untuk
  Episode 01 dari seri yang oleh `lib/helpers/seasonalParser.js`
  (`parseAnimeTitle` atas judul hasil komposisi: judul mapping + field
  season) dinyatakan BUKAN sekuel; selain itu tanpa tag. Isi:
  `<Judul> - <label episode> <subtitle>` (field subtitle entri menimpa
  bawaan `Subtitle Indonesia`), lalu resolusi terdeteksi dari nama asli
  (token 360–2160p; tidak terdeteksi = segmen dihilangkan — jangan
  mengarang 720p), ekstensi dari titik terakhir nama asli. Judul
  mapping disimpan apa adanya dan dinormalisasi saat komposisi
  (`sanitizeTitle`, tabel Veo 2026-11-07): `"` berpasangan menjadi
  `“`/`”`, `*` → `_`, `/` → spasi, `:` → `;`, `?` → `¿`, `\` → `_`,
  `|` → `_`, dan tabu lain di luar tabel (`<`, `>`, karakter kontrol)
  menjadi `_`. Field subtitle dinormalisasi dengan cara yang sama.

Upload Drive latar (`lib/downloader/driveSync.js`): khusus job
`uploadToDrive` yang hasil `runJob`-nya `sentToWa = true`, prosesor
menyalakan `startBackgroundDriveSync` TANPA menunggu — antrean tidak
tertahan upload. Urutannya: kirim WA → upload → hapus, dan penghapusan
folder job hanya bila kedua langkah sukses. `syncFileToDrive` ke folder
`defaultTargetFolderId()`: `uploaded` → folder dihapus + laporan
(tautan Drive bila ada); `skipped` DENGAN id (duplikat — Drive sudah
memegang file) dihitung sukses → tetap dihapus + dicatat di laporan;
`skipped` TANPA id (mis. melewati batas 10 GiB) → file dipertahankan +
alasan dilaporkan; error → dilaporkan MENTAH ke chat peminta + log
terminal, file dipertahankan.

## `.tt` interaktif dan klaim manual antrean

`.tiktok` / `.tt` (`plugins/downloader/tiktok.js`) adalah permukaan
interaktif TikTok adaptasi handler legacy: kirim video SD, lalu pengguna
mengirim teks `hd` (video HD) atau `mp3` (audio) dalam 40 detik — disimpan di
`lib/helpers/tiktokFollowup.js` (kunci chat:sender; kedaluwarsa malas,
tanpa timer). Sengaja teks biasa TANPA reply: prompt lama menyuruh
'balas', padahal reply ke pesan bot memicu trigger Ryn (bentrok) — sesi
follow-up-lah yang berlaku, bukan reply-nya. Plugin ini HANYA gerbang awal
+ interaksi: resolusi memakai engine TikTok yang sama dengan `.dl`, tanpa
resolver duplikat.

Supaya `.tt` dan `.dl` tidak bisa spam link yang sama bersamaan, `.tt`
menitipkan **klaim manual** ke file antrean yang sama (`manual: true` di
`lib/downloader/queue.js`): dedupe link, batas per pengguna, dan cooldown
60 detik berlaku penuh untuk kedua arah — tapi pump `.dl` melewati klaim
manual (tidak diproses ganda); `.tt` memprosesnya sendiri lalu `finish()`.
Klaim yang tidak di-finish (proses mati) kedaluwarsa 10 menit
(`MANUAL_CLAIM_TTL_MS`) agar tidak memblokir link selamanya.

Media `.tt` TIDAK dikirim langsung dari URL resolver (perbaikan
2026-10-24): `sendFile` dari URL lewat `fetchPublicBuffer`, yang
memvalidasi DNS — di sel VM ini resolver egress memetakan semua host
publik ke 198.18/15, sehingga validasi itu menolak media `.tt` sebagai
"jaringan privat" untuk semua link, sementara `.dl` jalan karena
mengunduh ke disk dulu. `.tt` kini mengunduh dulu lewat
`engine.download` (fetch biasa, streaming, plafon 150 MB) ke
`src/downloads/tiktok/tt-*`, mengirim dari file lokal, lalu menghapus
folder tmp-nya — berlaku juga untuk follow-up `hd`/`mp3`. Validasi
`net.js` sengaja TIDAK dilemahkan untuk menutupi ini. Kegagalan `.tt`
kini dilog mentah di terminal dan dilaporkan guardian ke DM founder
(fase `send`), bukan hanya pesan generik dispatcher.

Video `.tt` yang ukuran unduhannya melewati 25 MB dikirim sebagai
dokumen (gerbang 2026-11-05, `ttSendOptions` di plugin): berlaku untuk
video pertama maupun follow-up `hd`; di bawah ambang tetap video
inline. Foto dan audio tidak terpengaruh.

## Sesi pilih GoFile dan batch unduh-semua (`.dl` interaktif)

Folder GoFile (`.dl` link `gofile.io/d/...`) tidak lagi berhenti di daftar
"pilih #item + kirim ulang link" seperti Pixeldrain. Plugin `.dl`
menitipkan `options: { pickSession: true }` ke job antrean (options harus
objek serializable — antrean persist di JSON, bukan function); saat hasil
list muncul, `runJob.js` membuka **sesi pilih** di
`lib/helpers/pickSession.js` (kunci chat:sender, TTL 15 menit sliding,
kedaluwarsa malas) dan mengirim prompt bernomor:

- **angka** (teks biasa, tanpa reply) -> item itu diantrekan sebagai job
  `#item=<n>`; sesi TETAP BUKA, jadi user bisa pilih berkali-kali tanpa
  `.dl` ulang. Hook-nya di `plugins/downloader/pick.js` (plugin tanpa
  perintah, hanya `handler.before`).
- **all** -> satu job **batch**: sekuensial unduh -> kirim -> hapus per
  item (hemat disk dibanding unduh semua dulu). Progres
  (`done`/`failed`/`kept`, berisi index asli item) ditulis ke record
  antrean lewat `queue.update()` tiap item selesai — restart bot di tengah
  batch memulihkan job ke pending dan loop melewati item yang sudah
  terkirim/disimpan. Item oversized (>150 MB) dan gagal kirim TIDAK
  dihapus dari disk; jalurnya dilaporkan di ringkasan batch.
- **lanjut** -> bila batch masih berjalan, laporkan progresnya; bila batch
  terakhir sesi menyisakan item gagal, antrekan ulang HANYA item gagal
  itu (index asli dipertahankan supaya `#item` tidak bergeser).
- **batal** -> tutup sesi. Angka di luar daftar dibalas koreksi singkat.
- **Anti-spam**: pick adalah job antrean biasa (`sessionPick: true`) —
  dedupe saat mengantri dan batas per pengguna tetap berlaku, sehingga
  spam pick berubah menjadi antrean berurutan; cooldown 60 detik dilewati
  khusus pick (boleh pilih ulang item yang baru selesai). Pick yang
  mengantri >1 ikut memakai react ⏳ + pesan posisi antrean yang dihapus
  setelah selesai, dan react ✅/❌ di pesan angka/all saat job selesai.
- Sesi hilang saat bot restart (RAM), tapi batch yang sedang berjalan
  tetap lanjut otomatis lewat pemulihan antrean; setelah sesi expired,
  kirim ulang link akan membuka sesi baru dan item bisa dipilih lagi
  satu per satu. Pixeldrain dan `.tt` sengaja TIDAK diubah: Pixeldrain
  tetap pola #item lama, `.tt` tetap store `tiktokFollowup`-nya sendiri.

## Penjaga engine (guardian)

`lib/downloader/guardian.js` mengawasi kesehatan engine dari sisi laporan:

- Setiap kegagalan engine — fase `load` (registry gagal memuat file),
  `getInfo`, atau `download` (dari `.unduh` maupun antrean `.dl`) —
  dilaporkan **langsung ke nomor founder** (nomor pertama `global.founder`,
  fallback `global.owner`) lewat pesan WhatsApp.
- Chat peminta juga selalu dikabari: kegagalan `getInfo` maupun
  `download` pada job `.dl` mengirim pesan `❌ Unduhan #<id> gagal` +
  pesan error mentah ke chat asal untuk SEMUA provider (bukan hanya
  provider quiet/sosial) — job tidak boleh terasa hilang diam-diam
  (perbaikan 2026-11-06, insiden Pixeldrain HTTP 451).
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

Catatan resolver per platform:
- **tiktok** (keadaan 2026-10-24, menggantikan instatiktok): adaptasi
  legacy `downloader-tiktok.js` — savetik dulu, fallback tikwm, video
  utama SD dulu (HD hanya bila SD tak ada), foto didahulukan atas video.
  TIDAK ADA HEAD check media: HEAD dari VM terbukti 503/timeout pada URL
  yang hidup (itu yang membunuh probe 0/5), sementara legacy yang langsung
  sendFile jalan normal. Permukaan interaktifnya `.tt` (bawah); `.dl`
  memakai engine yang sama persis supaya selaras.
- **facebook** (keadaan 2026-11-07): port `scraper/facebook.js` milik
  yue-bot — POST `fbdownloader.to/api/ajaxSearch`, parsing tabel hasil
  dengan cheerio (`import { load }`, BUKAN ekspor default), kualitas
  dipilih 720p pertama lalu baris pertama. Sempat dicoba API ponta
  yue (`my.ponta.dpdns.org`) tapi API itu kini mewajibkan API key
  berbayar (401) dan plugin yue sendiri tak membawanya — dibuang di
  hari yang sama.
- instagram memakai resolver bersama `lib/downloader/instatiktok.js`
  (layanan instatiktok.com, dari legacy `downloader-download.js`):
  semua tautan hasil resolver adalah file satu postingan (multi-file
  -> list bermediaItems).
- pinterest memakai scrape langsung halaman pin (port pindl); twitter memakai vxtwitter dengan API
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
