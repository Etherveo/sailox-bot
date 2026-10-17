# BLUEPRINT — Bot WhatsApp Node.js (ESM) + Baileys · Generasi Baru

> **Status:** siap diimplementasikan · **Disusun:** 15 Oktober 2026
> **Pembaca utama:** AI agent yang membangun proyek **dari nol**, tanpa akses ke proyek lama.
> **Bahasa:** prosa Indonesia; identifier, nama file, dan istilah teknis tetap Inggris.

## Daftar Isi

0. Cara membaca dokumen ini
1. Tujuan, cakupan, dan keputusan arsitektur
2. Runtime, dependensi, dan package.json
3. Struktur proyek
4. Proses dan alur hidup (index.js, main.js, koneksi)
5. Konfigurasi (config.js)
6. Fondasi pesan: simple.js, store.js, print.js
7. Identitas LID-first
8. Database
9. Handler dan plugin
10. Jadibot (sub-bot)
11. lib/ modular (barrel export)
12. Keamanan dan keselamatan akun
13. Strategi pengujian
14. Rencana pengerjaan (milestone)
15. Asumsi dan keputusan terbuka

---

## 0. Cara Membaca Dokumen Ini

- Dokumen ini adalah **satu-satunya sumber kebenaran** untuk fitur dan perilaku yang harus dibangun. Jangan mencari atau menebak isi proyek lama; semua yang perlu ada sudah didefinisikan di sini.
- Kata normatif: **WAJIB** (harus dipenuhi), **DILARANG**, **SEBAIKNYA** (default kuat; boleh menyimpang dengan alasan tertulis), **OPSIONAL**.
- Dokumen ini berdampingan dengan `AGENTS.md` (aturan kerja agent). Jika bertabrakan soal keselamatan akun WhatsApp, rahasia, atau cara verifikasi, `AGENTS.md` menang. Jika ada hal yang ambigu atau belum tercakup, ambil tafsir paling konservatif dan tulis asumsinya di laporan akhir tiap milestone.
- **Tidak ada kode final di sini.** Blok kode adalah *template/pseudocode kontrak*, bukan implementasi yang boleh disalin mentah.
- Penanda: ✔ = fakta sudah diverifikasi pada 14 Okt 2026 (dokumentasi resmi Baileys, isi paket npm `@whiskeysockets/baileys@7.0.0-rc14`, dokumentasi Node.js, README paket, atau uji kecil lokal). ⚠ = bergantung perilaku server WhatsApp atau perangkat asli; tidak bisa dibuktikan tanpa perangkat, jadi **wajib** diuji manual oleh pemilik dan dicatat sebagai "belum terverifikasi".
- **DILARANG** menyalakan bot dengan sesi asli atau terhubung ke WhatsApp untuk "mengecek" hasil kerja. Verifikasi memakai unit test dengan fake socket (Bagian 13).

---

## 1. Tujuan, Cakupan, dan Keputusan Arsitektur

### 1.1 Tujuan

1. Membangun bot dari nol dengan inti ramping: koneksi, store, pipeline pesan, plugin, database, log.
2. Mempertahankan gaya penulisan plugin dan gaya kode (ESM, `Object.defineProperties` dengan `nama: { value(param) { … } }`).
3. Menambah fitur krusial: **jadibot** (user lain menjadi bot lewat pairing code, tanpa menjalankan server kedua).
4. Perombakan fundamental: plugin berfolder + hot-reload, database per-collection, identitas LID-first, `lib/` modular dengan barrel export.
5. Plugin yang sudah ada (jumlahnya banyak) harus bisa dimigrasi dengan perubahan minimal. Karena itu kontrak objek `m`, `conn`, `global.db.data.*`, dan flag `handler.*` dipertahankan (Bagian 6, 8, 9).

### 1.2 Di luar cakupan baseline (JANGAN dibangun)

- Pesan interaktif (button, list, carousel, template, quick-reply) beserta seluruh helper pengirimnya.
- RPG, game, leveling, clan, ekonomi. Hanya flag `rpg`/`game`/`nsfw` sebagai gerbang per-chat.
- Backend database selain JSON (Mongo, cloud, SQL), server Express, endpoint pengecekan nomor WhatsApp massal.
- Mode Mobile API.
- Pembuat stiker dan konversi media: baru dibuat di `lib/media/` saat ada plugin yang membutuhkannya.
- Mode whitelist grup/sewa, pembatasan jam akses, daftar grup khusus, gating plugin bertag `admin` lewat mode `restrict`.
- Migrasi data dari database lama (lihat Bagian 15).

Login bot utama mendukung **pairing code maupun QR code** (dipilih interaktif saat boot, default pairing — 4.3). Tiga plugin eksekusi kode owner (`exec`, `eval`, `o`) adalah bagian wajib dari cakupan ini, bukan contoh; lihat 9.12.

### 1.3 Keputusan arsitektur

| ID | Keputusan | Alasan |
|----|-----------|--------|
| A1 | ESM murni, Node.js ≥ 22.13, `@whiskeysockets/baileys` dipin persis di `7.0.0-rc14` | ✔ Baileys 7.x ESM-only (engines ≥ 20); dependensi terbaru (`chalk` 6, `file-type` 22) meminta Node ≥ 22; Permission Model stabil sejak 22.13 |
| A2 | Tiga lapis proses: `index.js` (supervisor) → `main.js` (bot utama) → satu proses worker per sub-bot | Isolasi crash; `global` dan `process.env` sub-bot terpisah secara desain; operator tetap hanya menjalankan satu `npm start` |
| A3 | Satu modul koneksi (`lib/connection`) dipakai bersama oleh bot utama dan worker sub-bot | Tidak ada duplikasi; kebijakan reconnect/pairing seragam |
| A4 | API plugin tetap berbasis `global.*` (`global.db`, `global.conn`, `global.owner`, …), tetapi tiap proses punya global sendiri | Kompatibel dengan plugin yang ada; worker tidak berbagi global dengan proses utama |
| A5 | Identitas utama = LID; aksi ke WhatsApp memakai JID nomor telepon (dengan fallback) lewat modul `lib/identity` | Permintaan pemilik; pemetaan resmi `sock.signalRepository.lidMapping` ✔ |
| A6 | Database: satu file JSON per collection, working set di memori, tulis atomik hanya untuk collection yang berubah | Permintaan pemilik; hindari satu file raksasa dan korupsi saat crash |
| A7 | Urutan deterministik: hook `all` → `before` → dispatch command → `after` | Menghilangkan perilaku listener yang tidak konsisten |
| A8 | Store terbatas (LRU + TTL), cache metadata grup, `getMessage` mencakup pesan milik bot sendiri | Cegah memory leak dan rate-limit; retry dekripsi berfungsi |
| A9 | Sandbox sub-bot = proses terpisah + Node Permission Model + env minimal + path confinement. **Bukan** modul `vm` | ✔ Dokumentasi Node menyatakan Permission Model hanya "seat belt", bukan jaminan melawan kode berbahaya; `vm` lebih lemah lagi. Batas jaminan dijelaskan jujur di 10.10 |
| A10 | Pesan dihapus dideteksi dari event `messages.update` dengan `messageStubType === REVOKE` | ✔ Event resmi di Baileys; tidak butuh event kustom |

---

## 2. Runtime, Dependensi, dan package.json

### 2.1 Runtime

- Node.js **≥ 22.13** (disarankan 24 LTS). Seluruh kode ESM: `"type": "module"`, tanpa `require`, tanpa `__dirname` bawaan (gunakan helper di `lib/helpers/paths.js`).
- Saat Node tidak mengenali flag Permission Model, launcher sub-bot menurunkan perlindungan secara terkontrol (lihat 10.10).

### 2.2 Dependensi inti (hanya ini di baseline)

| Paket | Versi | Peran | Verifikasi |
|-------|-------|-------|------------|
| `@whiskeysockets/baileys` | `7.0.0-rc14` (pin persis; dist-tag `latest`, terbit 29 Jul 2026) | Koneksi WhatsApp | ✔ paket diunduh dan diperiksa; ESM; ekspor yang dipakai di blueprint diuji impor |
| `awesome-phonenumber` | `^7.8.0` | Validasi dan format nomor | ✔ README: API baru `parsePhoneNumber()` (`.valid`, `.regionCode`, `.number.international`/`.e164`). API lama (default export, `new PhoneNumber()`) sudah tidak ada |
| `acorn` | `^8.19.0` | Parser JS: cek sintaks plugin, ekstraksi `handler.tags`, scan kebijakan, **tanpa mengeksekusi kode** | ✔ README: `parse(code, { ecmaVersion, sourceType: 'module' })`; MIT |
| `chalk` | `^6.0.1` | Warna console | ✔ ESM, Node ≥ 22 |
| `cfonts` | `^3.3.1` | Banner di `index.js` | ✔ `cfonts.say(text, opts)`; ⚠ berlisensi GPL-3.0-or-later, pertimbangkan bila proyek didistribusikan |
| `file-type` | `^22.1.1` | Deteksi tipe berkas | ✔ `fileTypeFromBuffer`; Node ≥ 22 |
| `jimp` | `^1.6.1` | Pemroses gambar (thumbnail) untuk Baileys | ✔ Source Baileys memakai `sharp` bila ada, kalau tidak `jimp`; bila keduanya tidak ada, pengiriman gambar melempar error. Peer range Baileys: `^1.6.1` |
| `syntax-error` | `^1.4.0` | Parser pesan error untuk plugin wajib `exec` (9.12); **tidak boleh dihapus** | ✔ MIT; impor default via interop CJS→ESM diuji langsung (`import syntaxerror from 'syntax-error'` memuat dan berjalan tanpa error) |
| `qrcode` | `^1.5.4` | Render QR code ke terminal untuk alur login QR (4.3) | ✔ `QRCode.toString(text, { type: 'terminal', small: true })` diuji menghasilkan ASCII QR yang benar; rilis terakhir Nov 2025, Node ≥ 10.13 |
| `ffmpeg-static` | `^5.3.0` | **OPSIONAL**: ffmpeg bila sistem tidak punya | Hanya dipasang bila fitur audio/video dipakai |

Catatan dependensi:

- `acorn` dipakai untuk cek sintaks plugin dan pemindaian kebijakan (9.9, 10.10); `syntax-error` terpasang terpisah dan **wajib**, semata karena `plugins/owner/exec.js` (9.12) mengimpornya langsung dan file itu tidak boleh diubah. Keduanya hidup berdampingan — satu bukan pengganti yang lain.

- **Tidak** memakai `pino` sebagai dependensi langsung: Baileys hanya memanggil `level`, `child`, `trace`, `debug`, `info`, `warn`, `error` pada logger ✔. Sediakan `silentLogger` (objek no-op) di `lib/helpers`.
- **Tidak** memakai `@hapi/boom`: status code disconnect dibaca dari `lastDisconnect.error.output.statusCode` ✔.
- **Tidak** memakai paket cache: antarmuka `CacheStore` Baileys hanya `get/set/del/flushAll` (+`close` opsional) ✔; buat cache sendiri (TTL + batas ukuran) di `lib/helpers/cache.js`.
- Peer dependency Baileys: `sharp` dideklarasikan **tidak opsional** (`*`) sehingga npm memasangnya otomatis, padahal `sharp` bersifat native dan gagal di sebagian platform. Karena itu repo WAJIB menyertakan `.npmrc` berisi `legacy-peer-deps=true` dan memasang `jimp` secara eksplisit. `link-preview-js` dan `audio-decode` ber-peer-range lama (`^3.0.0`, `^2.1.3`) yang bentrok dengan versi terbaru; jangan dipasang kecuali ada fitur yang membutuhkan, dan saat itu pakai versi dalam range tersebut.

### 2.3 Dibuang dari dependensi (tidak berperan di core)

| Dibuang | Pengganti |
|---------|-----------|
| `express`, `mongoose`/driver Mongo, `lowdb`, `lodash` | Health server `node:http`; database sendiri (Bagian 8); utilitas native |
| `moment`, `moment-timezone` | `Intl.DateTimeFormat` dengan `global.timezone` |
| `node-fetch`, `axios`, `form-data`, `formdata-node` | `fetch`, `FormData`, `Blob` bawaan Node |
| `yargs` | `node:util` `parseArgs` |
| `qrcode-terminal` | Digantikan `qrcode` (2.2) — perilaku serupa, rilis lebih baru |
| `fluent-ffmpeg`, `ffmpeg`, `node-webpmux`, `wa-sticker-formatter`, `link-preview-js` | Tidak dipakai di baseline |
| Semua library scraper/AI/RPG/downloader | Dipasang kembali **oleh plugin yang membutuhkannya saja** |

### 2.4 package.json dan berkas pendamping (kontrak)

- `"type": "module"`, `"engines": { "node": ">=22.13" }`, `"private": true`.
- Scripts: `start` → `node index.js`; `test` → `node test.js`. Tidak ada `postinstall` (direktori dibuat saat boot, Bagian 4.2).
- Alias import native Node (subpath imports): `"#lib"` → `./lib/index.js` dan `"#lib/*"` → `./lib/*`. Dipakai agar file core dipanggil dengan path tetap, mis. `#lib/simple.js`, tanpa `../../..`.
- `.npmrc`: `legacy-peer-deps=true`.
- `.gitignore` WAJIB mencakup: `node_modules/`, `config.js`, `.env`, `sessions/`, `bots/`, `databases/`, `tmp/`, `*.log`, `src/public/`, `src/private/`. Sertakan `config.example.js` tanpa nilai nyata. (`src/config/` **tidak** otomatis diabaikan — lihat 3.1 dan Bagian 15.)

---

## 3. Struktur Proyek

```
/
├─ index.js                 supervisor (entry npm start)
├─ main.js                  bot utama: boot, shutdown
├─ handler.js               4 fungsi: handler, participantsUpdate, groupsUpdate, deleteUpdate (+ dfail)
├─ config.js                konfigurasi lokal (gitignored)  ·  config.example.js (template)
├─ package.json  .npmrc  .gitignore  AGENTS.md  BLUEPRINT.md
├─ test.js                  pemeriksa sintaks + menjalankan node:test
├─ tests/                   unit test (node:test, tanpa koneksi WhatsApp)
├─ lib/
│  ├─ index.js              barrel utama (re-export barrel anak)
│  ├─ simple.js             CORE: protoType, serialize, smsg, makeWASocket (+ method conn)
│  ├─ store.js              CORE: cache pesan, metadata grup, nama kontak
│  ├─ print.js              CORE: log console (pesan masuk, logger, error mendalam)
│  ├─ connection/           siklus hidup koneksi (dipakai bot utama dan worker)
│  ├─ identity/             resolusi LID/JID, konversi untuk aksi, validator (lepas-pasang)
│  ├─ database/             engine + collections/ (satu file per collection)
│  ├─ plugins/              loader, watcher hot-reload, normalisasi, operasi berkas plugin
│  ├─ subbot/               manager, launcher, registry, ipc, sandbox, policy, runtime/, templates/
│  ├─ helpers/              utilitas umum (paths, cache, queue, lock, time, text, messages/dfail, …)
│  ├─ media/                konverter/upload (dibuat saat dibutuhkan)
│  └─ scraper/              scraper (dibuat saat dibutuhkan)
├─ src/                     scaffolding tambahan (3.1): public/ private/ config/ — sebagian gitignored
├─ plugins/<kategori>/<nama>.js     plugin bot utama
├─ databases/               users.json chats.json settings.json stickers.json stats.json subbots.json …  (runtime, gitignored)
├─ sessions/                auth state bot utama (runtime, gitignored)
├─ bots/                    sandbox sub-bot: bots/session@<nomor>/ (runtime, gitignored)
└─ tmp/                     berkas sementara (runtime, gitignored)
```

Aturan import:

- File CORE (`simple.js`, `store.js`, `print.js`) diimpor **langsung** dengan alias penuh (`#lib/simple.js`), **bukan** lewat barrel.
- Modul lain boleh lewat barrel (`#lib`). Barrel **hanya** me-re-export modul daun; modul daun dan file CORE **DILARANG** mengimpor barrel (mencegah dependensi sirkular).
- Setiap folder barrel (`database/`, `helpers/`, `media/`, `scraper/`, …) punya `index.js` yang mengekspor isi foldernya. Berkas bernama `example.js` pada contoh struktur pemilik hanyalah placeholder; ganti dengan modul nyata sesuai Bagian 6–11.

### 3.1 Folder `src/` (scaffolding — tujuan belum ditentukan)

```
src/
├─ public/               # gitignored; tujuan belum ditentukan
│  ├─ images/
│  ├─ videos/
│  ├─ documents/
│  ├─ audio/
│  └─ others/
├─ private/               # gitignored; tujuan belum ditentukan
│  ├─ images/
│  ├─ videos/
│  ├─ documents/
│  ├─ audio/
│  ├─ others/
│  ├─ URLs/
│  ├─ JSONs/
│  └─ debugs/
└─ config/                 # tujuan belum ditentukan; TIDAK gitignored secara default (lihat Bagian 15)
```

Ditambahkan atas permintaan eksplisit pemilik sebagai **scaffolding struktur folder saja** — ini bukan fitur dengan logika. Aturan:

- Ini `src/` di **root proyek**, berbeda dari `src/` milik tiap sandbox sub-bot (10.3), yang tujuannya sudah ditetapkan (resource sub-bot).
- AI agent WAJIB membuat seluruh direktori di atas (kosong) lewat `ensureDirs()` (4.2) agar strukturnya tersedia sejak boot pertama.
- AI agent **DILARANG** membangun logika apa pun di sekitarnya (server aset, endpoint unggah, loader, konvensi penamaan berkas) tanpa instruksi lanjutan dari pemilik. Jangan menebak tujuan `public/`, `private/`, atau `config/`, dan jangan mengimplementasikan sesuatu yang belum diminta.
- Penamaan subfolder (termasuk huruf besar/kecil pada `URLs/`, `JSONs/`, `debugs/`) dipertahankan persis seperti permintaan asli.
- `src/public/` dan `src/private/` masuk `.gitignore` (2.4). `src/config/` **tidak** diasumsikan gitignored — kemungkinan berisi templat/skema yang justru ingin dikomit (pola serupa `config.example.js`) — tetapi ini asumsi sementara (Bagian 15) sampai pemilik menegaskan.

---

## 4. Proses dan Alur Hidup

### 4.1 `index.js` — supervisor (perilaku dipertahankan)

1. Tampilkan banner (`cfonts`, teks dari `name` di `package.json`) dan info author dari `package.json`.
2. Jalankan `main.js` sebagai child process (`fork`), meneruskan argumen CLI.
3. **Protokol IPC** (dipertahankan): child → parent berupa string `'reset'` (parent me-restart child) dan `'uptime'` (parent membalas `process.uptime()` ke child). Parent meneruskan baris stdin ke child sebagai string, kecuali bila dijalankan dengan `--test`.
4. Penanganan exit: exit code ≠ 0 → restart. Exit code 0 → pantau perubahan file `main.js`, restart saat berubah.
5. Server HTTP kecil (`node:http`) untuk health/keep-alive; membalas teks sederhana. Port dari env `PORT`, lalu `SERVER_PORT`, fallback `3000`.
6. Gerbang password setup, **hanya** bila `sessions/creds.json` belum ada.

Perubahan kecil yang diizinkan (tidak mengubah perilaku normal):

- Password gerbang dibaca dari env `SETUP_PASSWORD`. Bila env kosong, gerbang nonaktif. **DILARANG** menaruh password literal di source.
- **Crash-loop guard**: bila child keluar dengan code ≠ 0 lebih dari 5 kali dalam 60 detik, restart ditunda dengan backoff eksponensial (maksimum 5 menit).
- Teruskan `SIGINT`/`SIGTERM` ke child, tunggu keluar graceful (maksimum 15 detik), lalu supervisor keluar.
- Parsing argumen memakai `node:util` `parseArgs` (menggantikan `yargs`).

### 4.2 `main.js` — bot utama

`main.js` HARUS ramping: hanya merangkai modul. Logika koneksi, database, plugin, dan sub-bot berada di `lib/`.

Urutan boot:

1. `import './config.js'` (efek samping: mengisi `global.*`), lalu validasi config (5.2). Config tidak valid → keluar dengan pesan jelas, tanpa menyentuh jaringan.
2. Arahkan `TMPDIR`, `TMP`, `TEMP` ke `<root>/tmp` supaya `os.tmpdir()` selalu di dalam proyek (✔ Baileys menulis berkas upload sementara ke `os.tmpdir()`). Buat direktori `tmp/`, `databases/`, `sessions/`, `bots/`, serta seluruh subfolder `src/public/`, `src/private/`, dan `src/config/` (3.1) bila belum ada (`ensureDirs()` di `lib/helpers`).
3. Pasang fondasi pesan sekali (idempoten): `protoType()` dan `serialize()` dari `#lib/simple.js`.
4. Muat database (`global.db`), jalankan auto-fill sapuan (8.3).
5. Muat plugin (`lib/plugins`) dan pasang watcher hot-reload (9.9).
6. Buat store (`#lib/store.js`).
7. Buat koneksi utama lewat `lib/connection` (`role: 'main'`, `authDir: 'sessions'`): `const { sock, start } = createConnection({ … })`; set **`global.conn = sock`** segera (dibutuhkan plugin wajib `owner/eval.js`, 9.12), lalu panggil `start()`. Jika belum terdaftar, jalankan alur login (4.3).
8. Setelah koneksi `open`: inisialisasi identity (resolusi LID untuk nomor di config), `SubBotManager.restoreAll()` bila `global.bots.enabled`, dan timer rutin (autosave database; pembersihan `tmp/`).
9. Handler dipasang oleh `lib/connection` (bukan oleh `main.js`).

Timer rutin: autosave database (default 30 detik, hanya collection yang berubah) dan pembersihan `tmp/` (berkas lebih tua dari 3 menit). Pembersihan **hanya** pada `<root>/tmp`; **DILARANG** menghapus berkas di direktori sementara sistem.

Shutdown (`SIGINT`/`SIGTERM`): hentikan timer → hentikan semua sub-bot (IPC `stop`, tunggu maksimum 10 detik, lalu kill) → flush database → tutup socket **tanpa logout** → `exit(0)`.

Error global:

- `unhandledRejection`: log lewat `print.printError` dengan konteks, lanjut berjalan. Bila lebih dari 20 kejadian dalam 60 detik → shutdown graceful dengan exit code 1.
- `uncaughtException`: log, shutdown graceful, exit code 1 (supervisor me-restart).

### 4.3 `lib/connection` — siklus hidup koneksi (dipakai main dan worker)

Kontrak `createConnection(options)` → controller `{ start(), stop(), sock, state, on() }`.

Opsi: `role` (`'main'|'sub'`), `authDir`, `phoneNumber` dan `pairingCode` (opsional), `handlers` (empat fungsi handler), `store`, `onStatus(state)`.

**Auth.** `useMultiFileAuthState(authDir)` lalu `makeCacheableSignalKeyStore(state.keys, silentLogger)`. `creds.update` WAJIB disimpan segera lewat antrean serial (tidak boleh dua penulisan `saveCreds` bersamaan). Tidak ada tambalan penyimpan sesi; bila disconnect berulang, diagnosis lewat log status code, bukan ditambal.

**Opsi socket (eksplisit).**

| Opsi | Nilai | Catatan |
|------|-------|---------|
| `logger` | `silentLogger` | Log aplikasi lewat `print.js`, bukan logger Baileys |
| `browser` | `Browsers.ubuntu('Chrome')` ✔ | Gunakan **hanya** tuple dari helper `Browsers`; tuple kustom ⚠ dapat membuat pairing code tidak muncul di ponsel |
| `version` | default pustaka | **DILARANG** mengambil versi terbaru saat runtime |
| `syncFullHistory` | `false` | Bot tidak butuh riwayat |
| `markOnlineOnConnect` | `global.markOnline` (default `false`) | Menjaga notifikasi ponsel |
| `generateHighQualityLinkPreview` | `false` | |
| `printQRInTerminal` | tidak di-set | ✔ dikonfirmasi dari source: opsi ini tidak lagi mengendalikan apa pun selain mencetak satu baris peringatan deprekasi bila truthy; render QR sepenuhnya manual lewat `connection.update` (alur login di bawah) |
| `getMessage` | `store.getMessage` | 6.5 |
| `cachedGroupMetadata` | `store.cachedGroupMetadata` | 6.5 |
| `msgRetryCounterCache` | cache buatan sendiri, dibuat **di luar** fungsi pembuat socket | Bertahan antar-reconnect |
| `shouldIgnoreJid` | tolak `status@broadcast`, `@broadcast`, `@newsletter` | |
| `keepAliveIntervalMs` / `connectTimeoutMs` / `retryRequestDelayMs` / `maxMsgRetryCount` | 30000 / 60000 / 250 / 5 | |
| `emitOwnEvents` | default (true) | Dibutuhkan agar pesan keluar tercatat di store |

**Event yang dipasang:** `connection.update`, `creds.update`, `messages.upsert`, `messages.update`, `groups.update`, `group-participants.update`, `contacts.upsert`/`contacts.update`, `lid-mapping.update`. Riwayat (`messaging-history.set`) diabaikan.

**Mesin status:** `idle → connecting → open → backoff → stopped | fatal`. `start()` saat sudah berjalan adalah no-op. **Tepat satu socket hidup per sesi**; sebelum membuat socket baru, socket lama ditutup dan listener-nya dilepas.

**Kebijakan reconnect** (status code dari `lastDisconnect.error.output.statusCode`):

| Kondisi | Tindakan |
|---------|----------|
| `loggedOut` (401) | Berhenti, status `logged_out`. **DILARANG** menghapus sesi otomatis; cetak instruksi untuk pairing ulang. |
| `connectionReplaced` (440) | Berhenti dan log: ada instance lain memakai sesi ini. Tidak reconnect. |
| `restartRequired` (515) | Buat socket baru segera (normal setelah pairing pertama). |
| `badSession` (500) | Coba sekali; bila berulang, berhenti dan laporkan. Tidak menghapus sesi. |
| `forbidden` (403), `multideviceMismatch` (411) | Berhenti dan laporkan (akun mungkin dibatasi atau tautan tidak valid). |
| Lainnya (`connectionClosed`, `connectionLost`, `timedOut`, `unavailableService`) | Reconnect dengan backoff eksponensial 1 s → ×2 → maksimum 60 s, jitter ±20%; reset setelah terbuka stabil 60 s. Lebih dari 30 kegagalan beruntun → berhenti dan laporkan. |

**Metode login** (hanya bila `!creds.registered`, hanya untuk **bot utama** — lihat catatan jadibot di akhir subsection ini):

Sebelum membuat socket, tanyakan metode lewat prompt (`lib/helpers/prompt.js`, sumber input sama seperti nomor — IPC bila ada supervisor, selain itu stdin):

```
Pilih metode login:
  [1] Pairing code  (default)
  [2] QR code
Masukkan angka (1/2):
```

Input `1`, kosong, atau tidak dikenali ⇒ **default pairing code**. Input `2` ⇒ QR code. Kedua metode memakai socket dan `connection.update` yang sama; yang berbeda hanya cara penautannya:

1. **Pairing code (default):**
   1. Minta `nomorbot` lewat prompt bila `global.nomorbot` kosong.
   2. Validasi nomor dengan `awesome-phonenumber`; kirim ke Baileys sebagai digit saja (E.164 tanpa `+`) ✔.
   3. Setelah socket siap (event `connection.update` pertama kali membawa `qr`, pertanda server siap menerima permintaan pairing), panggil `requestPairingCode(nomor, kodeKustom?)` **sekali saja** per percobaan. Kode kustom (`global.pairing`) ✔ harus tepat 8 karakter `[A-Za-z0-9]`; bila tidak valid, abaikan dan pakai kode acak (jangan melempar error).
   4. Cetak kode berformat `XXXX-XXXX` beserta langkah singkat (WhatsApp → Perangkat tertaut → Tautkan perangkat → Tautkan dengan nomor telepon). `requestPairingCode` memicu `creds.update` ✔, jadi pastikan tersimpan.
2. **QR code:**
   1. `nomorbot` **tidak** diminta (penautan lewat QR tidak memerlukan nomor).
   2. Setiap kali `connection.update` membawa `qr` baru, render ke terminal dengan paket `qrcode` (`QRCode.toString(qr, { type: 'terminal', small: true })` ✔) didahului instruksi singkat (WhatsApp → Perangkat tertaut → Tautkan perangkat → pindai kode). Bersihkan tampilan QR lama sebelum mencetak yang baru.
   3. ✔ Baileys menerbitkan `qr` baru secara otomatis selama belum dipindai — pertama setelah ±60 detik, lalu tiap ±20 detik (opsi `qrTimeout`) — sampai dipindai atau socket ditutup; **render ulang setiap kali**, jangan hanya sekali di awal.
3. Kedua metode berujung sama: setelah berhasil ditautkan, WhatsApp menutup koneksi dengan `restartRequired` ✔ → socket baru dibuat otomatis (lihat tabel kebijakan reconnect) → `open`.

Jadibot (10.4) **tidak** memakai pemilihan ini: alurnya tetap pairing-only lewat command WhatsApp sesuai spesifikasi aslinya — tidak ada terminal pada alur itu untuk menampilkan QR.

**Binding handler** (`bindHandlers`): `messages.upsert` → `handler` (hanya `type === 'notify'`, semua elemen `messages` diproses); `group-participants.update` → `participantsUpdate`; `groups.update` → `groupsUpdate`; `messages.update` berstub `REVOKE` → `deleteUpdate`. Stub ikon grup dan tautan undangan diterjemahkan menjadi panggilan `groupsUpdate` (`GROUP_CHANGE_ICON`, `GROUP_CHANGE_INVITE_LINK`). Stub `REVOKE` **bukan** perubahan tautan undangan; jangan disatukan.

Hot-reload `handler.js` (opsional, default mati; `global.hotReloadCore = true` untuk menyalakan). Hot-reload plugin wajib (9.9).

---

## 5. Konfigurasi (`config.js`)

### 5.1 Daftar nilai

`config.js` berisi penugasan `global.*` (gaya `.env`). Wajib ada:

| Key | Bentuk | Keterangan |
|-----|--------|------------|
| `global.founder` | `[[nomor, lidNumber, nama], …]` | Owner tertinggi |
| `global.owner` | `[[nomor, lidNumber, nama], …]` | Owner |
| `global.mods` | `[[nomor, lidNumber, nama], …]` | Moderator |
| `global.pairing` | string 8 karakter `[A-Za-z0-9]` | Kode pairing kustom bot **utama** (opsional bila kosong) |
| `global.nomorbot` | string digit | Nomor akun bot utama |

Format entri: `nomor` = digit E.164 tanpa `+` (mis. `"628…"`); `lidNumber` = digit LID **tanpa** `@lid` (boleh `""`, diisi runtime lewat pemetaan resmi, tidak menulis balik ke `config.js`); `nama` = string.

Nilai tambahan yang diputuskan blueprint ini:

| Key | Default | Fungsi |
|-----|---------|--------|
| `global.namebot` | `"Sailox"` | Nama bot untuk teks |
| `global.timezone` | `"Asia/Jakarta"` | Zona waktu log dan tampilan |
| `global.countryCode` | `"62"` | Mengubah nomor lokal `08…` menjadi `628…` |
| `global.prefix` | `".!/#$"` | Karakter prefix default; boleh string, array, atau RegExp |
| `global.defaultLimit` | `100` | Limit awal user baru |
| `global.markOnline` | `false` | Nilai `markOnlineOnConnect` |
| `global.cooldownMs` | `1000` | Jeda minimum antar-command per user |
| `global.maxMessageAgeSec` | `120` | Abaikan pesan lebih tua dari ini |
| `global.hotReloadCore` | `false` | Hot-reload `handler.js` |
| `global.database` | `{ dir: 'databases', autosaveSec: 30 }` | Opsi database |
| `global.identity` | `{ mentionForm: 'pn', validate: true, aliasMigration: true }` | Opsi identity (Bagian 7) |
| `global.bots` | lihat 10.12 | Opsi sub-bot |
| `global.legacyAliases` | `true` | Alias kompatibilitas plugin (9.2) |
| `global.APIs`, `global.APIKeys` | `{}` | Opsional; toleran bila kosong. Redaksi error memakai nilai `APIKeys` |
| `global.wait`, `global.eror` | teks | Teks umum yang lazim dipakai plugin; tambahkan konstanta lain hanya saat plugin membutuhkannya |

### 5.2 Validasi saat boot

- Semua array peran berbentuk benar; nomor hanya digit; tidak ada nomor ganda dalam satu array.
- `nomorbot` digit dan valid menurut `awesome-phonenumber` (bila tidak kosong); `pairing` valid atau kosong.
- Gagal validasi → keluar dengan pesan yang menyebut key dan alasannya (tanpa mencetak nilai rahasia).
- `config.js` berisi identitas pribadi: dilarang di-commit; `config.example.js` berisi placeholder.

### 5.3 Template (pseudocode kontrak)

```js
// config.example.js — placeholder; nilai nyata hanya di config.js lokal
global.founder = [["628xxxxxxxxxx", "1xxxxxxxxxxxxxx", "Nama Founder"]]   // [nomor, lidNumber, nama]
global.owner   = [["628xxxxxxxxxx", "",               "Nama Owner"]]      // lidNumber boleh kosong
global.mods    = [[]]
global.pairing = "ABCD1234"          // opsional, 8 karakter
global.nomorbot = "628xxxxxxxxxx"
global.namebot = "Sailox"
global.timezone = "Asia/Jakarta"
// … nilai tambahan sesuai tabel 5.1
```

---

## 6. Fondasi Pesan: `simple.js`, `store.js`, `print.js`

Ketiganya adalah **fondasi bot** dan WAJIB dipakai oleh seluruh pipeline. Mereka adalah file CORE (diimpor langsung, bukan lewat barrel).

### 6.1 Gaya kode wajib (descriptor map)

Method dan getter ditambahkan ke objek lewat **descriptor map**, bukan penugasan per properti. Gaya ini dipertahankan.

```js
// POLA WAJIB (pseudocode)
Object.defineProperties(target, {
  namaMethod: { value(param) { /* logic */ } },                 // method; non-enumerable
  namaGetter: { get() { /* dihitung saat diakses */ }, enumerable: true },
})
// DILARANG: menugaskan nilai per pesan di dalam smsg, mis. `m.chat = ...`
```

Alasan: getter dihitung malas (hanya saat dipakai), method tidak muncul di `JSON.stringify`/`Object.keys`, dan pola ini ✔ terbukti bekerja pada `proto.WebMessageInfo.prototype` serta pada objek socket Baileys rc14 (properti socket bersifat `configurable`). Getter ringkas yang berguna untuk debugging (mis. `isGroup`, `sender`, `mtype`) diberi `enumerable: true` agar tampil pada dump pesan.

### 6.2 Tiga fungsi fondasi

**`protoType()`** — idempoten; menambah helper ke prototype bawaan sebagai properti **non-enumerable** (DILARANG penugasan langsung yang membuatnya enumerable karena merusak `for…in`):

| Helper | Perilaku |
|--------|----------|
| `Buffer.prototype.toArrayBuffer()`, `ArrayBuffer.prototype.toBuffer()` | konversi dua arah |
| `Uint8Array/ArrayBuffer/Buffer.prototype.getFileType()` | `{ ext, mime }` via `file-type` |
| `String/Number.prototype.isNumber()` | benar hanya bila seluruh nilai numerik (bukan parse parsial) |
| `String.prototype.capitalize()` / `capitalizeV2()` | huruf pertama kapital / tiap kata kapital |
| `String.prototype.decodeJid()` | hapus suffix device (`:NN`), `@c.us` → `@s.whatsapp.net`; LID tetap `@lid` |
| `Number.prototype.toTimeString()` | durasi ms → teks Indonesia "X hari Y jam Z menit W detik" (bagian nol dilewati) |
| `Number/String/Array.prototype.getRandom()` | Array/String: elemen/karakter acak; Number n: integer acak `0..n-1` |

**`serialize()`** — idempoten; memasang getter dan method kontrak `m` (6.3) pada `proto.WebMessageInfo.prototype` memakai descriptor map. Dipanggil sekali saat boot.

**`smsg(conn, raw)`** — sinkron. Bila `raw` sudah instance `proto.WebMessageInfo`, pakai apa adanya (✔ `fromObject(instance)` mengembalikan objek yang sama dan field `remoteJidAlt`/`participantAlt` tetap ada). Bila objek polos, `proto.WebMessageInfo.fromObject(raw)`. Set `m.conn = conn` (writable, non-enumerable). Mengembalikan `null` bila `raw` kosong.

**DILARANG** mengkloning pesan dengan `fromObject(toObject(m))` atau `JSON.parse(JSON.stringify(m))` bila informasi identitas dibutuhkan: ✔ keduanya membuang `remoteJidAlt`/`participantAlt` (JSON juga tidak menyertakannya). Simpan instance asli, atau simpan field alt secara eksplisit.

### 6.3 Kontrak objek `m`

| Properti | Keterangan |
|----------|------------|
| `m.conn`, `m.key`, `m.id` | socket pemilik, key pesan, ID pesan |
| `m.isBaileys` | `true` bila pengirim adalah salah satu identitas bot kita (bot utama/sub-bot) dan bukan `fromMe` milik bot ini. Gunakan heuristik panjang/prefix ID: ✔ ID Baileys (`3EB0` + 18 hex) menyerupai ID WhatsApp Web dengan panjang antara 15, 16, dan 22. |
| `m.chat` | ID chat. Grup: `…@g.us`. Private: LID lawan bicara (diresolusi `identity.prime` sebelum plugin jalan) |
| `m.isGroup` | boolean |
| `m.sender` | **LID** pengirim (primer). Bila LID belum diketahui: JID sementara + `m.senderUnresolved = true` (7.3) |
| `m.senderJid` | JID nomor pengirim, atau `null` |
| `m.fromMe` | dikirim oleh akun bot ini (termasuk dari ponselnya) |
| `m.mtype`, `m.msg` | tipe konten dan isi konten setelah unwrap wrapper (ephemeral, view-once, edited, document-with-caption) memakai helper pustaka (`extractMessageContent`/`normalizeMessageContent`); wrapper `senderKeyDistributionMessage` dan `messageContextInfo` dilewati |
| `m.mediaMessage`, `m.mediaType` | konten media (image/video/audio/sticker/document) atau `null` |
| `m.text` | getter **dan setter**. Teks efektif dari semua varian (conversation, extendedText, caption media, …). Menugaskan `m.text = '…'` menimpa nilai efektif (dipakai hook `all` untuk menulis ulang input) |
| `m.mentionedJid` | dari `contextInfo`; dapat ditimpa; setelah `prime`, elemennya sudah dipetakan (7.4) |
| `m.name` | nama tampil pengirim (DB → pushName → nomor terformat) |
| `m.quoted` | objek kutipan atau `null` (di bawah) |
| `m.reply(text, chatId?, options?)` | membalas dengan mengutip pesan ini |
| `m.download(saveToFile?)`, `m.copy()`, `m.forward(jid, force?, options?)`, `m.delete()` | utilitas pesan |
| ditambah pipeline | `m.exp`, `m.limit`, `m.isCommand`, `m.plugin` (id plugin), `m.error` |

`m.quoted`: `mtype`, `mediaMessage`, `mediaType`, `id`, `chat`, `sender` (LID), `senderJid`, `fromMe`, `isBaileys`, `text`, `mentionedJid`, `name`, `vM` (WebMessageInfo untuk pesan yang dikutip), `fakeObj`, dan method `download()`, `reply()`, `copy()`, `forward()`, `delete()`.

### 6.4 Kontrak `conn` (method inti)

Ditambahkan ke socket Baileys dengan descriptor map di `makeWASocket(connectionOptions, options)`.

| Method | Ringkasan |
|--------|-----------|
| `decodeJid(jid)` | sinkron; normalisasi string |
| `getJid(id)` | sinkron, **hanya cache**; LID/JID → JID, atau input bila tak diketahui (kompatibilitas) |
| `toJid(id, ctx?)`, `toLid(id, ctx?)` | async; fasad `lib/identity` (Bagian 7) |
| `getName(id)` | async; `db.users[lid].name` → pushName di store → subjek grup → nomor terformat |
| `parseMention(text)` | sinkron (cache saja); ekstrak `@digit` → array id untuk `mentions` |
| `reply(jid, text, quoted?, options?)` | kirim teks; mention otomatis dari `@digit`; bila `text` Buffer → `sendFile` |
| `getFile(source, saveToFile?)` | sumber Buffer/URL/base64/path → `{ res, filename, data, mime, ext, delete() }` |
| `sendFile(jid, source, filename?, caption?, quoted?, ptt?, options?)` | tipe terdeteksi otomatis |
| `sendContact(jid, contacts, quoted?, options?)` | vCard satu/banyak |
| `sendPoll(jid, name, values, selectableCount?)`, `sendReact(jid, emoji, key)`, `editMessage(jid, key, text)` | pesan jenis terdokumentasi |
| `copyNForward(jid, message, forwardingScore?, options?)`, `cMod(jid, message, text?, sender?, options?)` | forward dan modifikasi pesan |
| `fakeReply(jid, text, fakeJid, fakeText, fakeGroupJid?, options?)` | OPSIONAL (kutipan palsu) |
| `downloadM(mediaMessage, type, saveToFile?)` | unduh media: batas ukuran, kumpulkan chunk lalu satu kali `concat` |
| `loadMessage(id)`, `pushMessage(messages)`, `serializeM(raw)` | akses store; `serializeM` = `smsg(this, raw)` |
| `chatRead(jid, participant, id)` | tandai terbaca |
| `getGroupMetadata(jid)` | dari cache; fetch dengan dedupe bila miss |
| `groupParticipantsUpdate(jid, ids, action)` | pembungkus konversi id + fallback (7.4) |
| `delay(ms)` | tunggu |
| `logger` | getter → `print.logger` (memenuhi `ILogger` Baileys ✔ + `success`) |

Semua pengiriman melewati **antrean keluar** (12.2). Pemanggilan `sendMessage` mentah dari handler dilarang.

**DILARANG** di baseline: helper tombol/list/carousel/template/adReply/loadingMsg, `makeInMemoryStore` (✔ sudah dihapus dari Baileys 7), `groupMetadata` per pesan, menimpa `sendMessage` tanpa menjaga signature aslinya.

### 6.5 `lib/store.js`

**Apa itu store:** memori sementara bot. Ia mengingat pesan yang baru lewat, metadata grup, dan nama kontak, supaya bot tidak terus bertanya ke server WhatsApp (berisiko kena rate-limit/ban) dan supaya pesan bisa dikirim ulang/didekripsi saat server memintanya. Baileys 7 tidak menyediakan store bawaan; aplikasi yang memilikinya.

Kontrak `createStore(options)` → `{ bind(conn), getMessage(key), cachedGroupMetadata(jid), getGroupMetadata(jid), loadMessage(id), push(messages), names, close() }`.

- **Pesan:** LRU terindeks `id` (maks 5000, TTL 6 jam, dapat diatur). Menyimpan **instance** `WebMessageInfo` (bukan klon JSON) beserta `senderLid`/`senderJid` hasil `prime`. WAJIB mencatat **pesan keluar bot** (hasil `sendMessage` dan `messages.upsert` bertanda `fromMe`) agar `getMessage` dapat melayani retry; tanpa ini penerima melihat "menunggu pesan ini".
- `getMessage(key)` → `message.message` atau `undefined`.
- **Metadata grup:** Map TTL (default 15 menit, maks 500 grup). Diisi dari `groups.upsert`/`groups.update`/`group-participants.update` (terapkan delta atau refetch dengan dedupe in-flight) dan fetch-on-miss dengan dedupe serta jeda minimum 1 detik antar-fetch. Peserta disimpan sebagai objek `{ id, lid, phoneNumber, admin }` ✔ (bentuk v7).
- **Nama kontak:** Map terbatas LID → nama dari `pushName` dan `contacts.*`.
- Pesan yang dihapus (`REVOKE`): store menandai `revoked` (tidak langsung membuang) agar `deleteUpdate` dapat mengambil `original`.
- Hanya di RAM; tidak ada pesan ditulis ke disk. Semua struktur berbatas ukuran/TTL; `close()` membersihkan timer.

### 6.6 `lib/print.js`

Lapisan tampilan console. WAJIB satu-satunya jalur output aplikasi (tidak ada `console.log` liar di modul core).

- `printMessage(m, conn)`: kotak log per pesan masuk berisi tipe pesan, pengirim (nomor internasional via `awesome-phonenumber` bila PN diketahui, plus nama), nama chat/grup, waktu (`Intl`, `global.timezone`), ukuran konten, `exp`/`level`, **label bot penerima** (`[main]` atau `[session@nomor]`), isi teks (markup WhatsApp diwarnai), detail dokumen/kontak/audio, dan mention. Tanpa preview gambar terminal.
- `logger`: `info`, `warn`, `error`, `debug`, `trace`, `success`; berprefix waktu; memenuhi `ILogger` Baileys.
- `printError(err, context)`: mencetak error **sampai ke akar**: telusuri rantai `cause` dan `AggregateError.errors`; tampilkan nama, pesan, stack ringkas (frame di dalam proyek disorot), serta konteks (id plugin, command, chat). Redaksi otomatis (ganti dengan `#HIDDEN#`): nilai `global.APIKeys`, token, isi kredensial, pairing code.
- `global.logPrivacy`: `'full'` (default untuk console proses utama; milik operator) atau `'masked'` (sembunyikan isi pesan dan nomor). Console **tidak pernah** ditulis ke berkas. Log relay dari sub-bot memakai `'masked'` (10.6).
- OPSIONAL: ring buffer 200 baris terakhir (`recent()`).

---

## 7. Identitas LID-first (`lib/identity`)

### 7.1 Prinsip

- **LID adalah ID primer**: `m.sender`, kunci `db.data.users`, kunci chat private, serta seluruh perbandingan peran di backend. JID nomor telepon (PN) adalah atribut dan bentuk untuk aksi ke WhatsApp.
- Konversi LID → PN terjadi **hanya di tepi**: eksekusi aksi WhatsApp (tag, kick, add, promote, demote, undang) dan tampilan nomor.
- Wajib memakai helper pustaka (`jidNormalizedUser`, `jidDecode`, `areJidsSameUser`, `isLidUser`, `isPnUser`, `isJidGroup`) ✔ semuanya terekspor. **DILARANG** `split('@')`, regex, atau `===` pada JID.

### 7.2 Sumber data (urut prioritas)

1. Field alternatif pada key pesan: `remoteJidAlt` (DM) dan `participantAlt` (grup) ✔ diisi Baileys saat decode.
2. `sock.signalRepository.lidMapping`: `getLIDForPN`, `getPNForLID`, `getLIDsForPNs`, `getPNsForLIDs`, `storeLIDPNMappings` ✔ — **semuanya async**. Mapping hanya ada untuk pasangan yang pernah dilihat pustaka.
3. Event `lid-mapping.update` (`{ pn, lid }`) ✔ → `learn()`.
4. Metadata grup: `participants[].id/lid/phoneNumber`, `addressingMode` ✔; identitas bot sendiri: `sock.user` (`id`, `lid`) ✔.
5. Database: `users[lid].jid` (lewat validator, 7.5).

### 7.3 API (kontrak)

| Fungsi | Hasil |
|--------|-------|
| `normalize(id)` | string kanonik (tanpa suffix device, `@c.us` → `@s.whatsapp.net`) atau `null` |
| `kind(id)` | `'lid' \| 'pn' \| 'group' \| 'broadcast' \| 'newsletter' \| 'unknown'` |
| `same(a, b)` | sinkron; benar bila setara setelah normalisasi, atau satu LID dan satu PN yang terpetakan di cache |
| `await toLid(any, ctx?)`, `await toJid(any, ctx?)` | menjalankan rantai 7.2; `null` bila gagal |
| `await resolve(input, { chat, m })` | `{ lid, jid, source }` atau `null` (aturan di bawah) |
| `await prime(m)` | langkah pipeline: mengisi `m.sender`, `m.senderJid`, `m.chat`, `m.quoted.sender`, `m.mentionedJid`; idempoten |
| `learn({ lid, jid, name })` | simpan mapping ke cache dan `users[lid].jid` |
| `await forAction(ids, action, ctx)` | id dalam bentuk yang tepat untuk aksi (7.4) |
| `isBot(id)`, `roleOf(id, ctx)` | identitas bot kita; `{ isFounder, isOwner, isMods }` dari daftar config (kedua bentuk) |

`prime(m)` bila LID tak dapat ditentukan: `m.sender` = PN sementara dan `m.senderUnresolved = true`. Record database dibuat dengan kunci sementara itu dan **digabung** ke kunci LID begitu LID diketahui (`global.identity.aliasMigration`), tanpa duplikasi user.

**Aturan `resolve(input)`** — input boleh berupa token `@mention`, nomor ketik bebas, JID, atau LID:

1. Balasan/quote dan mention terstruktur (`m.quoted.sender`, `m.mentionedJid[0]`) didahulukan atas teks.
2. Nomor ketik bebas: buang non-digit; bila diawali `0` ganti dengan `global.countryCode`; validasi `parsePhoneNumber('+' + digit).valid`; bentuk PN = `digit@s.whatsapp.net`; lanjut `toLid`.
3. Token `@digit` dalam teks bisa LID atau PN: coba `digit@lid` dulu bila ada di cache/DB/peserta grup, selainnya PN. Bila ambigu dan tidak ada bukti, pilih PN.
4. LID belum terpetakan → kembalikan `{ lid: null, jid, source: 'typed-unverified' }`. Plugin yang melakukan aksi destruktif (ban, kick) **wajib** menolak atau meminta konfirmasi pada hasil ini.

### 7.4 Konversi untuk aksi WhatsApp

- Aksi bertarget user (mention, `remove`, `add`, `promote`, `demote`, undang) memakai **JID nomor** (kebijakan pemilik). Pembungkus di `simple.js` melakukannya otomatis supaya plugin tidak lupa.
- `groupParticipantsUpdate` ⚠: Baileys meneruskan id **apa adanya** ke server ✔ (tidak ada konversi di source), dan contoh dokumentasi memakai JID nomor; perilaku server pada grup beralamat LID belum dapat diverifikasi tanpa perangkat. Karena itu pembungkus WAJIB: (1) kirim dalam bentuk PN; (2) bila status per-peserta bukan `'200'` dan ada bentuk alternatif, coba **sekali** dengan bentuk alternatif; (3) laporkan hasil akhir apa adanya. Fallback ini dapat dimatikan: `global.identity.actionFallback = false`.
- Mention: `global.identity.mentionForm` = `'pn'` (default; bila PN tak diketahui pakai LID), `'lid'`, atau `'auto'` (ikuti `addressingMode` grup) ⚠ perlu uji perangkat.
- PN tidak diketahui: aksi destruktif dan `add` **dibatalkan** dengan pesan jelas; mention memakai LID.
- Tampilan "nomor" ke user selalu dari PN; jangan menampilkan LID mentah sebagai nomor telepon.

### 7.5 Validator (modul yang bisa dilepas kapan saja)

`lib/identity/validator.js` memberi validasi tambahan memakai field `jid`/`lid` pada record user ketika konversi gagal atau datanya tidak konsisten.

- `validateTarget(input, ctx)` → `{ ok, lid, jid, reason }`; `checkRecord(user)` mendeteksi kejanggalan (satu `lid` dengan `jid` berbeda; satu `jid` dimiliki dua `lid`). Perbaikan otomatis **tidak** dilakukan.
- Pemasangan hanya lewat **satu titik**: bila `global.identity.validate` bernilai `true`, `resolve` memanggil validator sebagai langkah terakhir saat rantai 7.2 gagal. Tidak ada file core/handler lain yang boleh mengimpor validator.
- Karena itu validator dapat dicabut dengan satu flag, dan ke depan plugin yang membutuhkannya cukup memanggilnya langsung (`validateTarget`) sehingga validasi pindah ke level plugin.

### 7.6 Identitas bot dan peers

- Identitas bot sendiri: `conn.user` (`id`, `lid`) dinormalisasi → `identity.self`.
- **Peers** = himpunan identitas semua bot (utama + sub-bot aktif). Manager mengirimnya ke worker lewat IPC saat start dan saat berubah. `m.isBaileys = identity.isBot(m.sender) && !m.fromMe`. Pipeline mengabaikan pesan dengan `isBaileys === true` (pencegah loop antar-bot di grup yang sama).

### 7.7 Kasus uji wajib (tanpa koneksi)

1. PN → LID lewat `participantAlt`/`remoteJidAlt`; 2. PN → LID lewat `lidMapping` (fake); 3. LID → PN lewat peserta grup (`phoneNumber`); 4. nomor ketik `08…` → `62…`; 5. token `@digit` ambigu; 6. mapping tidak ada → `typed-unverified`; 7. alias migration menggabungkan record PN ke LID; 8. peran founder cocok lewat LID **atau** PN; 9. fallback aksi mencoba bentuk alternatif tepat sekali; 10. validator dimatikan lewat flag tanpa efek samping.

---

## 8. Database

### 8.1 Struktur dan registry collection

- Folder `databases/` berisi `<collection>.json`; setiap berkas adalah objek `{ [key]: record }`. Versi skema per collection di `databases/_meta.json`.
- Collection baseline: `users`, `chats`, `settings`, `stickers`, `stats` (+ `subbots` di proses utama).
- Setiap collection didefinisikan sebagai modul di `lib/database/collections/<nama>.js` yang mengekspor deskriptor: `{ name, version, defaults(key, seed), migrate?(record, fromVersion) }`. Engine menemukan semua deskriptor dari barrel `collections/index.js`. **Menambah objek database baru = menambah satu berkas + satu baris barrel**, tanpa menyentuh engine.

### 8.2 Akses konvensional (WAJIB dipertahankan)

```js
// pola akses plugin (kontrak)
let user = global.db.data.users[m.sender]      // kunci = LID
let chat = global.db.data.chats[m.chat]
let bot  = global.db.data.settings[botLid]
let stk  = global.db.data.stickers[hashBase64]
let st   = global.db.data.stats[pluginId]
```

`global.db.data.<collection>` adalah objek biasa (bukan Proxy dalam). API tambahan: `db.ensure(collection, key, seed?)`, `db.update(collection, key, fn)`, `db.extend(collection, fragmenDefault)`, `db.load()`, `db.save(collection?)`, `db.flush()`.

### 8.3 Auto-fill

- Pipeline memanggil `ensure('users', m.sender, { name, jid, lid })`, `ensure('chats', m.chat)`, `ensure('settings', botLid)` **sebelum** hook atau plugin apa pun berjalan.
- Record belum ada → dibuat dari `defaults(key, seed)`. Record sudah ada → **fill-missing**: tambahkan field default yang belum ada (rekursif untuk objek bersarang), **tidak** menimpa nilai yang ada, dan koreksi tipe angka/boolean yang korup (`NaN`, string) ke default. Dijalankan sekali per objek per proses (WeakSet) kecuali versi skema naik.
- Sapuan saat boot: bila versi di `_meta.json` lebih rendah dari versi skema, jalankan fill-missing + `migrate` pada semua record, lalu simpan.
- `extend(collection, fragmen)`: plugin/lib dapat menambah default (mis. fitur RPG) tanpa mengubah skema inti; berlaku untuk record baru maupun lama pada `ensure` berikutnya.
- Pada user, `jid`, `lid`, dan `name` selalu disinkronkan dari seed bila lebih baru.

### 8.4 Skema baseline (waktu = epoch milidetik)

| Collection (key) | Field dan default |
|------------------|-------------------|
| `users` (LID) | `lid`, `jid`, `name`, `registered:false`, `regTime:-1`, `age:-1`, `exp:0`, `level:0`, `limit:global.defaultLimit`, `premium:false`, `premiumTime:0`, `banned:false`, `banReason:''`, `banExpires:0`, `warn:0`, `afk:-1`, `afkReason:''` |
| `chats` (ID chat) | `isBanned:false`, `welcome:false`, `detect:false`, `delete:false` (antiDelete), `antiLink:false`, `game:false`, `rpg:false`, `nsfw:false`, `sWelcome:''`, `sBye:''`, `sPromote:''`, `sDemote:''`, `sDesc:''`, `sSubject:''`, `sIcon:''`, `sRevoke:''`, `users:{}` (per-chat per-user, mis. `{ warn }`, kunci LID) |
| `settings` (LID bot) | `self:false`, `autoread:false`, `pconly:false`, `gconly:false`, `jadibot:false`, `prefix:null` |
| `stickers` (base64 `fileSha256`) | `creator` (LID), `text`, `mentionedJid:[]`, `locked:false`, `at` |
| `stats` (id plugin) | `total:0`, `success:0`, `fail:0`, `last:0`, `lastSuccess:0` (hitung benar; tidak boleh menghitung ganda) |
| `subbots` (id sub-bot) | lihat 10.7 |

Catatan: default `chats.isBanned` adalah `false`. Bila pemilik menginginkan mode "chat baru nonaktif sampai diaktifkan", ubah **hanya** di `collections/chats.js`.

### 8.5 Persistensi

- **Muat:** berkas hilang → `{}` (collection baru, sah). Berkas ada tetapi tidak valid/kosong → coba `<file>.bak`; bila gagal → **batalkan boot** dengan pesan jelas. **DILARANG** menggantinya dengan default yang kemudian menimpa data asli.
- **Simpan:** serialisasi stabil → tulis `<file>.tmp` → rotasi satu cadangan `<file>.bak` (hanya bila isi lama valid) → `rename` atomik. Antrean penulis tunggal; hanya collection yang hash isinya berubah sejak simpan terakhir yang ditulis. Autosave berkala (`global.database.autosaveSec`), saat shutdown, dan `save()` eksplisit.
- Peringatan bila satu collection melebihi 20 MB (sinyal perlu backend lain).
- Sub-bot memakai engine yang sama dengan direktorinya sendiri (`bots/session@N/databases/`).

### 8.6 Konkurensi

Handler saling menyela di setiap `await`. Operasi baca-ubah-tulis pada nilai penting (limit, saldo, counter) WAJIB tanpa `await` di antara baca dan tulis, atau lewat `db.update(collection, key, fn)` yang memakai mutex per key (`lib/helpers/lock.js`). Pipeline memproses pesan dari satu chat secara berurutan (antrean per chat), antar-chat boleh paralel dengan batas konkurensi.

---

## 9. Handler dan Plugin

### 9.1 Template plugin kanonik

Gaya penulisan plugin dipertahankan persis. Import di baris paling atas; fungsi utama bernama `handler`; properti `handler.*` mendeklarasikan metadata dan syarat.

```js
// plugins/main/menu.js — template kanonik (pseudocode kontrak)
import path from 'node:path'                       // import selalu di baris atas

let handler = async (m, { conn, ...ctx }) => {
  // fungsi utama
}

handler.help = ["menu <category>"]     // tampilan command di daftar menu
handler.tags = ["main"]                // kategori; juga menentukan folder saat disimpan saveplugin
handler.command = /^(menu|help)$/i     // RegExp; atau ["menu", "help"] (string/RegExp campur)

// syarat tambahan (semua opsional)
handler.register = true    // wajib terdaftar
handler.limit = 1          // menguras n limit (hanya bila sukses)
handler.group = true       // wajib di grup
handler.private = true     // wajib di private
handler.admin = true       // hanya admin grup
handler.botAdmin = true    // hanya bila bot admin
handler.premium = true     // hanya premium
handler.mods = true        // hanya moderator
handler.owner = true       // hanya owner
handler.founder = true     // hanya owner tertinggi
handler.game = true        // wajib chat.game == true
handler.rpg = true         // wajib chat.rpg == true
handler.nsfw = true        // wajib chat.nsfw == true

// tanpa prefix
handler.command = new RegExp()         // berdampingan dengan prefixless (loader mengisi otomatis bila kosong)
handler.prefixless = /^menu$/i         // terpanggil tanpa prefix

export default handler
```

Plugin **listener-only** (tanpa command) boleh berupa (a) fungsi no-op dengan properti `before`/`all`/`after`, atau (b) modul dengan named export `before`/`all`/`after`. Loader menerima keduanya (`plugin = mod.default ?? mod`).

Parameter kedua (`ctx`) pada command dan `before`: `conn`, `match`, `usedPrefix`, `noPrefix`, `_args`, `args`, `command`, `text`, `participants`, `groupMetadata`, `user` (entri peserta pengirim), `bot` (entri peserta bot), `isFounder`, `isOwner`, `isMods`, `isPrems`, `isAdmin`, `isRAdmin`, `isBotAdmin`, `chatUpdate`, `__dirname`, `__filename`. Pada `all`: hanya `conn`, `chatUpdate`, `__dirname`, `__filename`. `this` di dalam plugin = `conn`.

### 9.2 Flag `handler.*` dan semantiknya

| Flag | Syarat | Pesan gagal (`dfail`) | Catatan |
|------|--------|-----------------------|---------|
| `disabled` | plugin dilewati sepenuhnya | — | |
| `founder` | `isFounder` | `founder` | |
| `owner` | `isOwner` (owner atau founder) | `owner` | |
| `maintenance` | `isOwner` | `maintenance` | plugin sedang diperbaiki |
| `mods` | `isMods` (mods, owner, atau founder) | `mods` | |
| `premium` | `isPrems` (premium, mods, owner, founder) | `premium` | |
| `group` | `m.isGroup` | `group` | |
| `botAdmin` | grup **dan** `isBotAdmin` | `group` / `botAdmin` | |
| `admin` | grup **dan** `isAdmin` | `group` / `admin` | **tanpa** bypass otomatis untuk owner |
| `private` | `!m.isGroup` | `private` | |
| `register` | `user.registered` | `unreg` | owner/founder dibebaskan |
| `game`, `nsfw` | di **grup**: `chat.game`/`chat.nsfw === true`; di private diizinkan | `game` / `nsfw` | |
| `rpg` | wajib grup, `chat.rpg === true`, dan user terdaftar | `rpg` | |
| `level` | `user.level >= handler.level` | `level` | |
| `limit` | `user.limit >= handler.limit` kecuali `isPrems` | `limit` | dikurangi **setelah sukses** (error tidak mengurangi); plugin boleh menimpa `m.limit` |
| `exp` | hadiah exp saat sukses (default 10) | — | |
| `fail` | fungsi penolakan kustom `(type, m, conn)` | — | menggantikan `dfail` untuk plugin itu |
| `command` | RegExp, string, atau array | — | tanpa `command` ⇒ bukan plugin command |
| `prefixless` | RegExp, string, atau array | — | lihat 9.5 |
| `help`, `tags` | metadata menu | — | `help` string/array, `tags` array |
| `before`, `all`, `after` | hook | — | lihat 9.3 |
| `unload` | dipanggil saat plugin diganti/dihapus | — | opsional (bersihkan timer/listener) |

Alias kompatibilitas (aktif bila `global.legacyAliases = true`, loader mencatat peringatan deprekasi sekali per plugin): `customPrefix` → `prefixless`, `rowner` → `founder`, `ctx.isROwner` → `isFounder`.

Gerbang tambahan di pipeline (bukan flag plugin): cooldown per user (`global.cooldownMs`), mode `self`/`pconly`/`gconly`, ban user/chat.

### 9.3 Hook `all`, `before`, `after`

Keduanya, `all` dan `before`, menerima **teks apa pun tanpa prefix** (media tanpa caption pun lewat dengan `m.text === ''`), sehingga dipakai sebagai listener, mis. saat bot menunggu input lanjutan dari user. Perbedaannya:

| | `all(m, ctx)` | `before(m, ctx)` | `after(m, ctx)` |
|---|---|---|---|
| Tahap | A (pertama) | B (setelah semua `all`) | D (setelah command selesai) |
| Dijalankan untuk | setiap pesan yang lolos gerbang inti, semua plugin yang punya `all`, berurutan | idem, untuk plugin yang punya `before` | plugin yang baru saja menjalankan command |
| Konteks | minimal | penuh: peran, `participants`, `groupMetadata`, `user`, `bot`, `isAdmin`, `isBotAdmin`, … | penuh + `m.error` bila gagal |
| Nilai return | **diabaikan**; tidak bisa memblokir | **truthy ⇒ lewati dispatch command milik plugin itu saja**; pipeline lanjut ke plugin lain | diabaikan |
| Boleh mengubah `m` | ya (mis. `m.text`) | ya | — |
| Dipakai untuk | pengamat, statistik, penulis-ulang input (stiker → perintah) | penjaga/moderasi (antilink), state percakapan lanjutan | pembersihan, log tambahan |

Aturan:

- Pola `return true` pada kondisi "tidak berlaku" di dalam `before` (mis. pengirim adalah admin) **aman**: efeknya hanya melewati command plugin itu sendiri.
- Urutan deterministik: semua `all` dijalankan sebelum parsing prefix; tidak ada hook yang terlewat hanya karena command plugin lain cocok. Urutan antar-plugin = urutan alfabetis `id`.
- Error di hook diisolasi (tidak menghentikan hook lain atau command) dan dilaporkan lewat `printError`.

### 9.4 Pipeline `handler.js` (pseudocode)

`handler.js` mengekspor **empat fungsi**: `handler`, `participantsUpdate`, `groupsUpdate`, `deleteUpdate` (+ `dfail`). Dipanggil dengan `this = conn`. Hanya logika pipeline; tidak ada fungsi bantu yang bisa dijadikan modul `lib/`.

```
handler(chatUpdate):                                  // this = conn
  if chatUpdate.type != 'notify': return              // 'append' = riwayat; tidak memicu balasan
  for raw of chatUpdate.messages:                     // SEMUA elemen, bukan hanya yang terakhir
    queue.byChat(raw.key.remoteJid).push(() => processOne(raw))

processOne(raw):
  G0  buang: tanpa isi pesan, status@broadcast, @newsletter, stub/protokol, usia > maxMessageAgeSec
  m = smsg(conn, raw); await identity.prime(m)
  G1  dedupe (ring 2000 id); store.push(m)
  G2  if m.isBaileys: return                          // bot lain (peers)
  user = db.ensure('users', m.sender, seed); chat = db.ensure('chats', m.chat); cfg = db.ensure('settings', botLid)
  role = identity.roleOf(...)  → isFounder/isOwner/isMods; isPrems = isMods || user.premium
  G3  mode (non-owner): cfg.self → return jika bukan owner/fromMe; cfg.pconly & grup → return; cfg.gconly & private → return
  G4  ban (non-owner): chat.isBanned → return; user.banned (auto-lepas bila banExpires lewat) → return
  grup: groupMetadata = await store.getGroupMetadata(m.chat)   // cache, bukan per pesan
        isAdmin/isRAdmin/isBotAdmin via identity.same pada id/lid/phoneNumber
  cfg.autoread → conn.chatRead(...) lewat antrean keluar
  Tahap A: untuk tiap plugin dengan `all`:    await safe(all, m, ctxMin)
  Tahap B: skip = {}; untuk tiap plugin dengan `before`: if await safe(before, m, ctxFull) then skip.add(id)
  Tahap C (dispatch):
    firstFail = null
    untuk tiap plugin command (urut id), bukan disabled/skip:
      parsed = parseCommand(plugin, m.text)           // 9.5
      jika tidak cocok: continue
      cek cooldown, lalu rantai izin 9.2 berurutan
      jika gagal: firstFail ??= {type, plugin}; continue
      jalankan: m.isCommand = true; m.plugin = id
        try { await plugin.call(conn, m, ctxFull); sukses }
        catch (e) { m.error = e; tangani (9.7) }
        finally { Tahap D: after hook; stats; kurangi limit bila sukses; tambah exp }
      break                                           // paling banyak satu command per pesan
    jika tidak ada yang dijalankan dan firstFail: dfail(firstFail.type, m, conn)
  finally: print(m, conn)
```

Antrean per chat menjaga urutan pesan dalam satu chat; antar-chat paralel dengan batas konkurensi (default 8).

### 9.5 Parsing prefix, prefixless, dan command

- **Prefix efektif** = `cfg.prefix ?? global.prefix`, dinormalisasi menjadi pencocok: string → kelas karakter dari karakter-karakternya (di-escape); array → tiap elemen string/RegExp; RegExp → apa adanya.
- **Plugin biasa:** `match = prefixMatcher.exec(m.text)`; tidak cocok ⇒ bukan command. `usedPrefix = match[0]`.
- **Plugin `prefixless`:** pencocok = `handler.prefixless` (RegExp/string/array) diuji terhadap awal teks; **tidak** memakai prefix global, dan plugin itu **hanya** terpanggil tanpa prefix. `usedPrefix` = teks pemicu yang cocok. Wajib berdampingan dengan `handler.command = new RegExp()`; bila `command` kosong, loader mengisinya otomatis.
- Setelah prefix: `noPrefix = text.slice(usedPrefix.length)`; token dipisah `/\s+/`; `command = token[0]` huruf kecil (hanya untuk pencocokan); `args = token.slice(1)` (huruf asli); `ctx.text` = sisa setelah token command, dengan spasi awal dipangkas dan **baris baru dipertahankan**.
- **Pencocokan `command`:** RegExp → `.test(command)`; string → sama (tak peka huruf); array → salah satu elemen cocok. `m.text` kosong ⇒ tidak ada command.

### 9.6 Peran, izin, dan `dfail`

- Hierarki: `isFounder ⊂ isOwner ⊂ isMods`. `isOwner = isFounder || termasukDaftar(owner)`; `isMods = isOwner || termasukDaftar(mods)`; `isPrems = isMods || user.premium`. Keanggotaan daftar dicek lewat LID **atau** PN (7.3). `m.fromMe` ⇒ `isFounder` di bot utama (`isOwner` di sub-bot).
- Peran grup: `isAdmin` (admin atau superadmin), `isRAdmin` (superadmin), `isBotAdmin`; dihitung dari `participants` memakai `identity.same` pada `id`/`lid`/`phoneNumber` ✔.
- `dfail(type, m, conn)` ada di `lib/helpers/messages.js` (kamus teks penolakan berbahasa Indonesia, singkat), dipasang juga sebagai `global.dfail`. Kunci minimal: `founder`, `owner`, `mods`, `premium`, `group`, `private`, `admin`, `botAdmin`, `unreg`, `rpg`, `game`, `nsfw`, `maintenance`, `limit`, `level`, `cooldown`. Pesan `cooldown` dikirim paling banyak sekali per 10 detik per user.

### 9.7 Penanganan error command

- `throw 'teks'` (string) = **pesan untuk user**: dibalas apa adanya (idiom validasi input).
- `throw new Error(...)` = kesalahan internal: user menerima pesan generik singkat tanpa stack/path/kunci; detail (teks error, id plugin, command, chat) dikirim ke founder lewat DM (throttle: maks 1 laporan per plugin per menit), setelah redaksi rahasia (`print.redact`).
- Semua error dicatat lewat `print.printError`; `stats[id].fail++`; proses tidak boleh crash; satu error tidak memengaruhi pesan lain.

### 9.8 Event grup dan pesan dihapus

**`participantsUpdate({ id, participants, action, author })`** — ✔ pada Baileys 7 `participants` berupa **array objek** (`GroupParticipant`), bukan string. Normalisasi tiap peserta ke `{ lid, jid }`.

- `add` / `remove` → sambutan/perpisahan bila `chat.welcome`; `promote` / `demote` → pemberitahuan bila `chat.detect`.
- Teks dari `chat.sWelcome`/`sBye`/`sPromote`/`sDemote`; bila kosong pakai default di `lib/helpers/messages.js`. Placeholder: `@user` (mention peserta), `@subject`, `@desc`.
- Lewati bila `settings.self` aktif, atau bila peserta adalah bot sendiri (bot ditambahkan ke grup: inisialisasi `chats[id]` dan prefetch metadata saja).
- Perbarui cache metadata (delta). Batasi notifikasi per grup (maks 10 per menit) agar penambahan massal tidak menjadi banjir pesan. Mention lewat `identity.forAction`.

**`groupsUpdate(updates)`** — untuk tiap update grup yang memuat `subject`, `desc`, `announce`, `restrict`, atau (dari stub) ikon/tautan undangan: kirim pemberitahuan bila `chat.detect` (teks `sSubject`/`sDesc`/`sIcon`/`sRevoke`, plus default untuk `announce`/`restrict`). Jangan umumkan perubahan yang dilakukan bot sendiri. Perbarui cache metadata.

**`deleteUpdate(upd)`** — fitur antiDelete, dengan kontrak yang eksplisit:

```
deleteUpdate(upd):   // dari messages.update: key = pesan asli (id, chat); update.messageStubType == REVOKE; update.key = key pesan revoke
  chat = db.data.chats[upd.chat]
  if (!chat || chat.delete !== true) return           // GUARD PERTAMA, satu kondisi tunggal; sebelum lookup/kirim apa pun
  if (settings.self) return
  if (upd.revokerIsBot) return                        // bot sendiri yang menghapus
  original = store.loadMessage(upd.id); if (!original) return        // tak tersimpan → diam
  if (original.fromMe or identity.isBot(original.sender)) return
  // kirim pemberitahuan singkat "@pengirim menghapus pesan" + salin isi lewat copyNForward
  // batasi maks 3 resend per chat per menit; abaikan status@broadcast
```

- Pemicu **hanya** `messages.update` dengan `messageStubType === REVOKE` ✔. Pesan yang diedit **bukan** penghapusan dan tidak boleh memicu fitur ini.
- Opt-in per chat (`chat.delete`), tidak menyimpan apa pun ke disk (store hanya RAM), dan hanya bekerja untuk pesan yang masih ada di store.
- Test wajib: flag `false` ⇒ tidak ada akses store/kirim; flag `true` + pesan tersimpan ⇒ tepat satu resend; revoker = bot ⇒ tidak resend; event edit ⇒ tidak dipicu.

### 9.9 Loader plugin dan hot-reload (`lib/plugins`)

- **Pemindaian:** rekursif `plugins/**/*.js` (abaikan nama berawalan `.` dan folder `node_modules`). `id` = path relatif ber-slash (`main/menu.js`); kategori = folder pertama. Registri `global.plugins` = `{ [id]: plugin }` (kompat), urut alfabetis; API `plugins.get/list/byTag/reload(id)/remove(id)`.
- **Memuat:** (1) parse sintaks dengan `acorn` ✔ sebelum import; gagal ⇒ pertahankan versi lama dan log error tanpa crash. (2) `import(fileUrl + '?v=' + counter)`; `plugin = mod.default ?? mod`. (3) Normalisasi: `help` → array string; `tags` → array huruf kecil; `command`/`prefixless` → fungsi pencocok; alias legacy; plugin tanpa fungsi dan tanpa hook diabaikan dengan peringatan.
- **Hot-reload:** `fs.watch(pluginsRoot, { recursive: true })` (rekursif didukung Node ≥ 20 di Linux; fallback polling `fs.watchFile` bila gagal/ENOSPC), debounce 150 ms per berkas, bandingkan `mtime`. Add/change ⇒ reload; unlink ⇒ remove.
- **`saveplugin` dan `deleteplugin` WAJIB memicu reload secara eksplisit** (`plugins.reload(id)` / `plugins.remove(id)`), tidak hanya mengandalkan watcher (watcher tidak andal di semua filesystem). Dedupe agar tidak reload ganda.
- **Memori:** ✔ ESM tidak bisa membuang modul; tiap reload meninggalkan instance lama. Simpan penghitung reload per plugin; peringatkan bila > 50 dan sarankan restart. `handler.unload()` opsional dipanggil saat diganti/dihapus.
- Peringatan bila dua plugin mengklaim command string yang sama. Plugin rusak tidak boleh menghentikan loader.

### 9.10 Struktur folder plugin dan operasi berkas

- `plugins/<kategori>/<nama>.js`; kategori = `handler.tags[0]` (slug `[a-z0-9_-]`). Nama berkas **unik di seluruh pohon** (tak peka huruf) agar `getplugin`/`deleteplugin` tidak ambigu. Plugin listener-only diawali `_` (mis. `_antilink.js`); tanpa tag ⇒ kategori `misc`.
- Logika berkas ada di `lib/plugins/files.js` dengan parameter `root` (dipakai bot utama dan sub-bot):

**`findPluginFile(root, name)`** — rekursif di bawah `root`; cocok bila basename tanpa `.js` sama persis (tak peka huruf); format `kategori/nama` untuk disambiguasi. 0 hasil ⇒ "tidak ditemukan"; >1 hasil ⇒ minta `kategori/nama`. Menolak `..`, path absolut, dan simlink.

**`saveplugin <nama>`** (kode dari balasan/lampiran `.js`/teks):

1. Sanitasi nama: huruf kecil, buang `.js`, regex `^[a-z0-9_][a-z0-9_-]{0,47}$`.
2. Batas ukuran (bot utama 512 KB; sub-bot `maxPluginKB`); UTF-8 tanpa byte NUL.
3. Parse `acorn` (`sourceType: 'module'`); gagal ⇒ tolak dengan baris/kolom.
4. Ekstrak `tags` dari AST (penugasan `handler.tags = [...]` atau `export const tags`): ambil string **pertama**; tidak ada ⇒ `misc`.
5. `findPluginFile`: bila sudah ada di folder lain, tulis di folder tujuan lalu hapus yang lama (pindah); bila folder sama, timpa.
6. Tulis atomik (tmp lalu rename) pada path yang sudah divalidasi, lalu `plugins.reload(id)` (dan `plugins.remove(idLama)` bila pindah).
7. Balas: lokasi, id, command terdeteksi, hasil reload (sukses/gagal + error).

**`getplugin <nama|kategori/nama>`** — `findPluginFile` lalu kirim isi sebagai teks (≤ 3000 karakter) atau dokumen `.js` bila lebih panjang.

**`deleteplugin <nama|kategori/nama>`** — `findPluginFile`, hapus, `plugins.remove(id)`, hapus folder kategori bila kosong, konfirmasi.

### 9.11 Plugin referensi baseline (minimal untuk membuktikan kerangka)

| Plugin | Tujuan |
|--------|--------|
| `main/menu.js` | menu dari `help`/`tags` (kelompok per tag; argumen kategori) |
| `main/register.js` | pendaftaran user (`registered`) |
| `info/ping.js` | uji respons dan uptime |
| `info/getlid.js` | tampilkan LID dan JID pengirim/target (membantu mengisi config) |
| `owner/saveplugin.js`, `getplugin.js`, `deleteplugin.js` | CRUD plugin (9.10) |
| `owner/banuser.js`, `unbanuser.js`, `banchat.js`, `unbanchat.js` | moderasi lewat `identity.resolve` |
| `owner/self.js` | toggle `settings.self` (self/public), persisten |
| `owner/setprefix.js` | ubah `settings.prefix`, persisten |
| `group/_antilink.js` | contoh hook `before` |
| `system/_stickercmd.js` dan `tools/setcmd.js` | contoh hook `all`: stiker terdaftar di `stickers` memicu perintah lewat penimpaan `m.text` |
| `jadibot/*` | lihat Bagian 10 |
| `owner/exec.js`, `owner/eval.js`, `owner/o.js` | eksekusi kode owner — **WAJIB**, migrasi verbatim, lihat 9.12 |

### 9.12 Plugin Eksekusi Owner (WAJIB — migrasi verbatim)

Tiga plugin di bawah ini berasal dari proyek lama milik pemilik (`owner-exec.js`, `owner-exec2.js`, `owner-o.js`) dan **WAJIB** dipindahkan ke proyek baru **persis seperti aslinya**, tanpa mengubah logikanya sedikit pun. Ini fitur owner yang sangat dibutuhkan, bukan contoh atau opsional — daftar di luar cakupan di 1.2 tidak mencakup ketiganya.

**Prosedur migrasi (urutan wajib):**

1. Tulis ketiga berkas **byte-untuk-byte** seperti blok kode di bawah, ke path pada kolom "Target" masing-masing. Jangan memformat ulang, jangan "merapikan" indentasi, jangan mengubah tanda kutip, jangan menghapus baris kosong.
2. Penuhi "Kebutuhan agar jalan" per berkas di bawah — ini **bukan** mengubah isi plugin, hanya memenuhi apa yang sudah diimpor/dirujuknya (satu dependensi npm, satu global baru).
3. Jalankan pipeline normal proyek baru (pemeriksa sintaks `acorn`, lalu `plugins.reload()` lewat loader, 9.9) untuk memuat ketiganya dan konfirmasi tidak ada error muat.
4. Laporkan hasilnya persis (lolos/gagal, pesan error bila ada) sesuai `AGENTS.md` — ini pengujian kompatibilitas, bukan alasan untuk mengubah logika. Satu-satunya perbaikan yang diizinkan bila muat gagal: penyesuaian **path import** yang rusak murni karena pemindahan folder. Tidak ada kasus itu di ketiga berkas ini (tak satu pun memakai import relatif — dikonfirmasi di bawah), jadi secara normal **tidak ada baris yang perlu disentuh** di dalam `handler` ketiganya.

#### `plugins/owner/exec.js` — eksekusi internal Baileys (`>`, `=>`)

Target: `plugins/owner/exec.js` (kategori `owner` sesuai `handler.tags` aslinya, konsisten dengan aturan 9.10). Trigger: prefixless, pola `=?> ` (mis. `> 1+1` atau `=> conn.user`).

````js
import syntaxerror from 'syntax-error'
import { format } from 'util'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { createRequire } from 'module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(__dirname)

let handler = async (m, _2) => {
  let { conn, usedPrefix, noPrefix, args, groupMetadata } = _2
  let _return
  let _syntax = ''
  let _text = (/^=/.test(usedPrefix) ? 'return ' : '') + noPrefix
  let old = m.exp * 1
  try {
    let i = 15
    let f = {
      exports: {}
    }
    let exec = new (async () => { }).constructor('print', 'm', 'handler', 'require', 'conn', 'Array', 'process', 'args', 'groupMetadata', 'module', 'exports', 'argument', _text)
    _return = await exec.call(conn, (...args) => {
      if (--i < 1) return
      console.log(...args)
      return conn.reply(m.chat, format(...args), m)
    }, m, handler, require, conn, CustomArray, process, args, groupMetadata, f, f.exports, [conn, _2])
  } catch (e) {
    let err = syntaxerror(_text, 'Execution Function', {
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
        sourceType: 'module'
    })
    if (err) _syntax = '```' + err + '```\n\n'
    _return = e
  } finally {
    conn.reply(m.chat, _syntax + format(_return), m)
    m.exp = old
  }
}
handler.help = ['> ', '=> ']
handler.tags = ['owner']
handler.customPrefix = /^=?> /
handler.command = /(?:)/i

handler.rowner = true

export default handler

class CustomArray extends Array {
  constructor(...args) {
    if (typeof args[0] == 'number') return super(Math.min(args[0], 10000))
    else return super(...args)
  }
}
````

Kebutuhan agar jalan:

- Dependensi `syntax-error` (2.2) **wajib terpasang** — tanpa ini baris `import syntaxerror from 'syntax-error'` gagal saat plugin dimuat.
- `handler.customPrefix` → dipetakan otomatis ke `prefixless`, dan `handler.rowner` → ke `founder`, oleh alias legacy loader (9.2/9.9). **Tidak perlu dan tidak boleh diubah di file**; loader yang menangani.
- `handler.command = /(?:)/i` adalah pola "selalu cocok" — sah berdampingan dengan `prefixless` sesuai kontrak 9.5 (setara `new RegExp()`). Loader tidak boleh menganggap field ini perlu diisi ulang.
- Tanpa import relatif (`../` atau `./`) — lokasi folder barunya (`plugins/owner/`, bukan flat `plugins/`) tidak memengaruhi resolusi importnya.
- Catatan fidelitas: berkas asli tidak diakhiri newline; ini tidak berpengaruh pada perilaku (diverifikasi byte-untuk-byte terhadap sumber aslinya).

#### `plugins/owner/eval.js` — eksekusi shell Linux/PowerShell (nama file diubah dari `owner-exec2.js`)

Target: `plugins/owner/eval.js`. **Hanya nama berkas yang berubah** (`exec2.js` → `eval.js`, sesuai permintaan); isi, termasuk `handler.command` dan trigger `$ `, tetap persis seperti ini.

````js
import cp, { exec as _exec } from 'child_process'
import { promisify } from 'util'
let exec = promisify(_exec).bind(cp)
let handler = async (m, { conn, isOwner, command, text }) => {
  if (global.conn.user.jid != conn.user.jid) return
  m.reply('Executing...')
  let o
  try {
    o = await exec(command.trimStart()  + ' ' + text.trimEnd())
  } catch (e) {
    o = e
  } finally {
    let { stdout, stderr } = o
    if (stdout.trim()) m.reply(stdout)
    if (stderr.trim()) m.reply(stderr)
  }
}
handler.customPrefix = /^[$] /
handler.command = new RegExp
handler.rowner = true
export default handler
````

Kebutuhan agar jalan:

- **`global.conn` harus ada**, menunjuk ke socket bot utama — file ini membandingkan `global.conn.user.jid` dengan `conn.user.jid`. Section 4.2 (langkah 7) menugaskan `global.conn = sock` segera setelah koneksi utama dibuat; tanpa ini baris pertama handler melempar `TypeError` pada **setiap** pemanggilan.
- `handler.command = new RegExp` (tanpa argumen) = pola selalu-cocok (setara `/(?:)/`), sama seperti `exec.js` — sah berdampingan dengan `customPrefix`/`prefixless`.
- `handler.tags` **tidak dideklarasikan** di file ini (beda dari dua file lain). Untuk migrasi verbatim ini, tempatkan langsung di `plugins/owner/` (mengikuti nama file lama `owner-exec2.js`) tanpa menunggu loader menyimpulkan tag — ini keputusan path satu kali saat migrasi, bukan perubahan logika.
- `isOwner` ada di parameter destructuring tapi tidak dipakai di badan fungsi — gerbang akses sesungguhnya dari `handler.rowner` (dicek pipeline **sebelum** `handler` dipanggil). Dibiarkan apa adanya.
- **Catatan arsitektur (bukan bug, jangan diubah):** baris `if (global.conn.user.jid != conn.user.jid) return` berasal dari arsitektur lama yang kemungkinan multi-sesi-dalam-satu-proses, mencegah command ini jalan bila dipicu dari koneksi selain bot utama. Di arsitektur baru (proses terpisah per sub-bot, A2/A9), perlindungan **sesungguhnya** terhadap sub-bot bukan baris ini — melainkan fakta bahwa **file ini sama sekali tidak ada** di `lib/subbot/templates/plugins/` (10.9), sehingga tidak pernah termuat di proses sub-bot mana pun. Baris ini dipertahankan verbatim sesuai instruksi, tetapi jangan mengandalkannya sebagai batas keamanan sub-bot.
- Tanpa import relatif; lokasi folder baru tidak memengaruhi resolusinya.

#### `plugins/owner/o.js` — jalankan script JS/Python/C++/PHP/Java

Target: `plugins/owner/o.js`. Trigger: `handler.command = ['o']` (array, didukung 9.2).

````js
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

const tempDir = path.join(process.cwd(), 'tmp');

if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

const detectLanguage = (code) => {
    const trimmedCode = code.trim().toLowerCase();
    if (trimmedCode.startsWith('print') || trimmedCode.includes('def ')) return { lang: 'python', ext: 'py', exec: 'python3' };
    if (trimmedCode.startsWith('<?php') || trimmedCode.includes('echo ')) return { lang: 'php', ext: 'php', exec: 'php' };
    if (trimmedCode.startsWith('public class') || trimmedCode.includes('system.out')) return { lang: 'java', ext: 'java', exec: 'java' };
    if (trimmedCode.startsWith('#include') || trimmedCode.includes('cout')) return { lang: 'cpp', ext: 'cpp', exec: 'g++' };
    if (trimmedCode.startsWith('console.log') || trimmedCode.includes('function ')) return { lang: 'javascript', ext: 'js', exec: 'node' };
    return { lang: 'javascript', ext: 'js', exec: 'node' };
};

const handler = async (m, { conn, text, command, usedPrefix }) => {
    if (!text) {
        return m.reply('Eh Senpai, kasih kode dulu dong, aku ga bisa nebak pikiran Senpai!');
    }

    const code = text.trim();
    const { lang, ext, exec: execCmd } = detectLanguage(code);
    const tempFilePath = path.join(tempDir, `temp.${ext}`);

    fs.writeFileSync(tempFilePath, code);

    if (lang === 'cpp') {
        exec(`g++ ${tempFilePath} -o ${path.join(tempDir, 'temp')}`, (compileErr) => {
            if (compileErr) {
                m.reply(`Error kompilasi C++: ${compileErr.message}`);
                fs.unlinkSync(tempFilePath);
                return;
            }
            exec(`${path.join(tempDir, 'temp')}`, (runErr, stdout, stderr) => {
                fs.unlinkSync(tempFilePath);
                fs.unlinkSync(path.join(tempDir, 'temp'));
                if (runErr) return m.reply(`Error: ${runErr.message}`);
                if (stderr) return m.reply(`Stderr: ${stderr}`);
                m.reply(`Output C++:\n${stdout}`);
            });
        });
    } else if (lang === 'java') {
        exec(`javac ${tempFilePath}`, (compileErr) => {
            if (compileErr) {
                m.reply(`Error kompilasi Java: ${compileErr.message}`);
                fs.unlinkSync(tempFilePath);
                return;
            }
            exec(`java -cp ${tempDir} temp`, (runErr, stdout, stderr) => {
                fs.unlinkSync(tempFilePath);
                fs.unlinkSync(path.join(tempDir, 'temp.class'));
                if (runErr) return m.reply(`Error: ${runErr.message}`);
                if (stderr) return m.reply(`Stderr: ${stderr}`);
                m.reply(`Output Java:\n${stdout}`);
            });
        });
    } else {
        exec(`${execCmd} ${tempFilePath}`, (error, stdout, stderr) => {
            fs.unlinkSync(tempFilePath);
            if (error) {
                m.reply(`Error ${lang}: ${error.message}`);
                return;
            }
            if (stderr) {
                m.reply(`Stderr ${lang}: ${stderr}`);
                return;
            }
            m.reply(`Output ${lang}:\n${stdout}`);
        });
    }
};

handler.help = ['o'];
handler.tags = ['owner'];
handler.command = ['o'];
handler.group = false;
handler.owner = true;

export default handler;
````

Kebutuhan agar jalan:

- Tanpa dependensi npm tambahan (hanya `node:child_process`, `node:fs`, `node:path` bawaan) dan tanpa import relatif — paling portabel dari ketiganya. Murni butuh interpreter/compiler sistem (`python3`, `php`, `java`+`javac`, `g++`, `node`) tersedia di PATH; bila salah satu tidak ada, command untuk bahasa itu gagal dengan pesan error dari `exec()` apa adanya (perilaku asli, tidak diubah).
- `handler.group = false`: di bawah kontrak gerbang baru (tabel 9.2), nilai falsy berarti **tidak ada** syarat grup (boleh dipakai di grup maupun private) — sama seperti tidak mendeklarasikan `handler.group` sama sekali. **Perlu diverifikasi saat uji kompatibilitas** (langkah 3 di atas): bila perilaku yang diharapkan pemilik justru "hanya private", beri tahu — kontrak lama untuk nilai `false` eksplisit tidak dapat dipastikan dari isi file ini saja.
- `handler.owner = true` (bukan `rowner`/founder) → gerbang levelnya **owner**, bukan founder — berbeda dari dua file lain yang founder-only. Dipertahankan apa adanya.
- **Risiko operasional yang sudah ada di kode asli (diketahui, bukan untuk diperbaiki tanpa diminta):** nama berkas sementara tetap (`temp.<ext>`, `temp.class`, binari `temp`) di `tempDir` yang sama untuk semua pemanggilan — dua eksekusi bersamaan (dua owner, atau satu owner dua kali cepat) dapat saling menimpa/mengganggu berkas satu sama lain. Ini perilaku asli; tidak diubah kecuali pemilik memintanya secara eksplisit di luar migrasi verbatim ini.
- `tempDir = path.join(process.cwd(), 'tmp')` — bukan berkas `tmp/` terpusat dari `lib/helpers/tmp.js` (6, 4.2) secara langsung, tetapi mengarah ke path yang sama (`<root>/tmp`) selama proses dijalankan dengan cwd di root proyek (normal untuk `npm start`). Pembersihan berkala `tmp/` (4.2) ikut membersihkan sisa berkas plugin ini bila compile/exec gagal sebelum sempat `unlinkSync`.

#### Batas gerbang akses dan sub-bot (WAJIB dipatuhi, berlaku untuk ketiganya)

- Ketiganya tetap digerbangi persis seperti aslinya: `exec.js` dan `eval.js` founder-only (`rowner` → `founder`), `o.js` owner-only (`owner`). **Dilarang** melonggarkan ke `mods`/`premium`/publik dengan alasan apa pun, termasuk "mempermudah pengujian".
- Ketiganya **dilarang keras** masuk ke `lib/subbot/templates/plugins/` (10.9) atau tersalin ke sandbox sub-bot mana pun lewat mekanisme apa pun — termasuk bila pemilik sendiri men-`saveplugin` isi persis berkas ini ke sub-bot saat `allowCustomPlugins` aktif. Ini justru skenario nyata yang membuat pemindai kebijakan L6 (10.10) ada: pola `child_process`, konstruktor `Function`-like untuk eval, dan sentinel `new RegExp`/`/(?:)/)` sebagai command di atas adalah persis pola yang harus ditolak pemindai itu di Fase 2.
- Kompromi identitas owner (sesi dicuri, SIM-swap, perangkat bobol) pada bot dengan ketiga plugin ini aktif **setara dengan kompromi penuh host**, karena `exec`/`eval` dapat menjalankan kode/perintah apa pun dengan privilese proses Node. Ini konsekuensi yang disengaja dari fitur yang diminta, bukan cacat desain — cukup disadari saat menentukan siapa saja yang masuk `global.founder`/`global.owner` (5.1).

---

## 10. Jadibot (Sub-bot)

### 10.1 Tujuan dan batas

Konsep: user mengirim `.jadibot <nomor_wa>` ke bot utama → bot utama mengirim **pairing code** → user memasukkan kode di *Perangkat Tertaut* WhatsApp → nomor user ikut menjadi bot (**sub-bot**) tanpa operator menjalankan server kedua.

Sub-bot adalah bot penuh di akun milik user, memakai pipeline yang sama (Bagian 9) tetapi dengan sesi, database, plugin, resource, dan peran yang **terpisah dan terbatas**. Spesifikasi pemilik (semua WAJIB):

1. Sesi sub-bot disimpan terpisah; tidak mengganggu bot utama.
2. Plugin dan resource terbatas: sub-bot tidak otomatis bisa memakai seluruh kode/berkas utama (terutama command sensitif owner dan `config.js`). Fitur dasar tersedia: `saveplugin`, `getplugin`, `deleteplugin`, `menu`, `ping`, dan sejenisnya.
3. Satu folder sandbox per sesi di `bots/session@<nomor>/` agar antar-sub-bot tidak saling mengintervensi.
4. Isi folder: `plugins/` dan `src/`, ditambah folder lain sesuai kebutuhan mekanisme (`auth/`, `databases/`, `tmp/`).
5. Sandbox menjaga ketat agar tidak ada akses keluar folder, termasuk akses (CRUD) ke variabel global dan env (`process.env`). Pengetatan keamanan boleh disetel setelah basis berjalan (Fase 2), tetapi arsitektur **harus sudah memungkinkannya** sejak awal.

### 10.2 Arsitektur

```
index.js (supervisor)
 └─ main.js  (proses utama: bot utama + SubBotManager)
     ├─ worker  session@628111…   (proses sendiri · cwd = bots/session@628111…)
     └─ worker  session@628222…   (proses sendiri · cwd = bots/session@628222…)
```

Mengapa satu proses per sub-bot (keputusan A2/A9):

- `global` dan `process.env` **terpisah secara fisik** (memori berbeda). Ini satu-satunya cara yang benar-benar menjamin poin 5 untuk variabel global dan env; sandbox di dalam satu proses (`vm`, dsb.) tidak bisa menjaminnya.
- API plugin berbasis `global.*` tetap berfungsi tanpa bentrok: global di worker adalah global sub-bot itu sendiri.
- Crash, memory leak, atau loop tak berujung di satu sub-bot tidak menjatuhkan bot utama maupun sub-bot lain; manager dapat me-kill worker.
- Operator tetap hanya menjalankan satu `npm start`.
- Biayanya memori per sub-bot (satu proses Node + satu socket). Karena itu ada `maxBots` dan `heapMB` (10.12).

Modul (`lib/subbot/`):

| Modul | Tugas |
|-------|-------|
| `manager.js` | Orkestrasi: `create`, `launch`, `stop`, `delete`, `restoreAll`; kuota; registry; penyebaran `peers` |
| `launcher.js` | Strategi spawn: menyusun `execArgv`, `env`, `cwd`, `stdio`; mendeteksi flag Permission Model |
| `registry.js` | Akses collection `subbots` |
| `ipc.js` | Protokol pesan: validasi skema, tipe, ukuran |
| `sandbox.js` | `sandboxPath()`, scaffold folder, penghapusan aman, pengukuran disk |
| `policy.js` | (Fase 2) scan kode plugin dengan `acorn` |
| `runtime/worker.js` | Titik masuk proses sub-bot |
| `templates/plugins/**` | Template plugin awal yang disalin ke sandbox |

### 10.3 Struktur folder `bots/`

```
bots/session@<nomor>/
├─ plugins/        plugin milik sub-bot (subfolder per tag), diisi dari template awal
├─ src/            resource milik sub-bot (aset, data statis); bukan plugin, tidak dieksekusi sebagai plugin
├─ auth/           auth state sesi sub-bot (terpisah dari sessions/ milik bot utama)
├─ databases/      users/chats/settings/stickers/stats milik sub-bot (engine yang sama, 8.5)
├─ tmp/            berkas sementara (TMPDIR proses sub-bot)
└─ logs/           OPSIONAL: log status ringkas tanpa isi pesan
```

- Nama folder wajib cocok `^session@\d{7,15}$` (digit E.164). Hanya manager yang membuatnya.
- Data kontrol (status, owner, kuota, persetujuan) **tidak** disimpan di dalam sandbox karena sub-bot dapat menulis ke sandbox-nya sendiri. Registry ada di `databases/subbots.json` milik proses utama (10.7).

### 10.4 Alur lengkap `.jadibot <nomor>`

**Validasi di bot utama** (plugin `jadibot/jadibot.js`, `handler.private = true` agar kode pairing tidak bocor di grup):

1. Fitur aktif di dua tingkat: `global.bots.enabled` dan `settings[botLid].jadibot`. User tidak banned; kapasitas `maxBots` dan kuota `maxPerUser` belum penuh.
2. Nomor: bersihkan lalu `parsePhoneNumber` ✔ harus valid. **Nomor harus milik pengirim**: sama dengan `m.senderJid` (PN), kecuali pengirim `isOwner`/`isFounder`. Bila PN pengirim tidak diketahui, tolak (kepemilikan tak dapat diverifikasi). Tujuannya mencegah user memicu notifikasi pairing ke nomor orang lain.
3. Bukan nomor bot utama; tidak sedang dipakai sub-bot aktif; sandbox belum ada atau berstatus `stopped`/`failed`/`logged_out`.
4. Rate limit: maksimum 3 percobaan per jam per user dan 1 percobaan per 5 menit per nomor.

**Eksekusi:**

5. `manager.create(nomor, owner)`: buat sandbox (10.3), salin template plugin (10.9), tulis registry `status: 'pairing'`.
6. `manager.launch(id)`: `launcher` men-spawn worker dengan flag dan env di 10.10, menunggu pesan `ready` (maksimum 15 detik, selain itu kill), lalu mengirim `start`.
7. Worker boot (10.6): menyusun global sub-bot, DB dan plugin di sandbox, membuat koneksi (`role: 'sub'`, `authDir: 'auth'`). Pada event `qr` pertama ✔ memanggil `requestPairingCode(nomor)` dengan **kode acak** (bukan `global.pairing` milik bot utama), lalu mengirim IPC `pairing-code`.
8. Manager meneruskan kode ke user lewat bot utama (chat private): kode berformat `XXXX-XXXX`, langkah singkat (WhatsApp → Perangkat tertaut → Tautkan perangkat → Tautkan dengan nomor telepon), batas waktu, dan peringatan risiko akun (akun dipakai sebagai bot; risiko pembatasan/ban ditanggung pemilik akun; jangan bagikan kode). Kode **tidak** dicetak ke console.
9. User memasukkan kode. ⚠ WhatsApp membatasi jumlah perangkat tertaut per akun; bila sudah penuh, pairing gagal dan user perlu melepas satu perangkat.
10. WhatsApp menutup koneksi dengan `restartRequired` ✔ → worker membuat socket baru otomatis (4.3) → `open` → worker mengirim `status { state: 'open', me }`.
11. Manager menandai `active`, menyimpan `botLid`/`botJid`, menyebarkan `peers` baru ke seluruh worker, lalu memberi tahu user (disertai daftar command dasar).
12. Timeout pairing (default 120 detik tanpa `open`): kill worker, status `failed`, hapus sandbox bila sesi belum pernah terdaftar, beri tahu user.

### 10.5 Protokol IPC

Amplop JSON `{ v: 1, type, …payload }` lewat kanal IPC bawaan `fork` (`serialization: 'json'`). Ukuran maksimum 64 KB per pesan. Pesan tipe tak dikenal, skema salah, atau terlalu besar **diabaikan** dan dihitung (anomali berulang ⇒ kill worker).

Urutan awal: manager `fork` → worker `ready` → manager `start`.

| Arah | `type` | Payload | Fungsi |
|------|--------|---------|--------|
| M→W | `start` | `{ sandbox, number, owner: { number, lid, name }, config: { prefix, timezone, countryCode, defaultLimit, maxPlugins, maxPluginKB, allowCustomPlugins, outbound, logRelay }, pairing: { needed } }` | Konfigurasi awal sub-bot (tanpa rahasia bot utama) |
| M→W | `peers` | `{ ids: [lid, …] }` | Identitas semua bot (7.6) |
| M→W | `stop` | `{ reason, logout? }` | Hentikan graceful |
| M→W | `ping` | `{}` | Cek hidup |
| W→M | `ready` | `{ pid }` | Worker siap menerima `start` |
| W→M | `pairing-code` | `{ code }` | Kode untuk diteruskan ke user |
| W→M | `status` | `{ state, me?, reason?, selfCheck? }` | `state`: `connecting`, `pairing`, `open`, `backoff`, `stopped`, `logged_out`, `replaced`, `fatal` |
| W→M | `heartbeat` | `{ t, rss, heapUsed }` | Setiap 10 detik |
| W→M | `log` | `{ level, line }` | Log ringkas, termasuk `masked` dan terbatas laju |
| W→M | `fatal` | `{ message }` | Pesan error yang sudah disanitasi |

Fase 2 (OPSIONAL): pasangan `request`/`response` sebagai *broker kemampuan* (mis. proses utama melakukan konversi media atas permintaan worker yang tidak boleh men-spawn proses).

### 10.6 Runtime worker

- Entry `lib/subbot/runtime/worker.js`. **DILARANG** mengimpor `config.js` atau `main.js`.
- Self-check saat boot, dilaporkan di `status.selfCheck`: (a) `process.permission?.has('fs.read', <root>/config.js)` harus `false`; (b) `Object.keys(process.env)` hanya berisi kunci yang diizinkan (10.10, L2). Bila (a) gagal, manager menerapkan kebijakan 10.10 (paksa `allowCustomPlugins = false` dan beri peringatan keras).
- Menyusun global dari pesan `start`: `global.owner` = `[[nomorUser, lidUser, nama], [nomorSubBot, lidSubBot, 'self']]`; `global.mods = []`; `global.founder = []`; `global.prefix`, `global.timezone`, `global.countryCode`, `global.defaultLimit`. **Tanpa** `APIKeys`, `pairing`, `nomorbot`, atau nilai config bot utama lainnya.
- `global.db` = engine pada `<sandbox>/databases`; `global.plugins` = loader pada `<sandbox>/plugins` (hot-reload aktif, 9.9); store sendiri; pipeline `handler.js` yang sama (hanya-baca).
- **Worker WAJIB keluar bila kanal IPC putus** (`disconnect`), agar tidak ada worker yatim yang tetap memegang sesi dan menyebabkan `connectionReplaced` ketika proses utama restart. Juga menangani `SIGTERM` (graceful: flush DB, tutup socket tanpa logout).
- Antrean keluar lebih ketat dari bot utama (default 3 pesan/detik, jeda 1200 ms per chat).
- Log: stdout/stderr worker dibaca manager dan diberi prefix `[session@nomor]`; mode `masked` (tanpa isi pesan dan nomor) dengan batas 20 baris/detik. Isi chat user sub-bot **tidak** ditampilkan di console operator.

### 10.7 Registry (`databases/subbots.json`)

Kunci = id (`session@<nomor>`). Field: `id`, `number`, `ownerLid`, `ownerJid`, `status` (`pairing` | `starting` | `active` | `stopped` | `logged_out` | `failed`), `botLid`, `botJid`, `createdAt`, `startedAt`, `lastActiveAt`, `stoppedAt`, `restarts: { count, windowStart }`, `limits` (override kuota), `policy: { allowCustomPlugins, approved: [] }`, `lastError` (sudah disanitasi).

### 10.8 Peran di dalam sub-bot

| Peran | Siapa |
|-------|-------|
| `founder`, `mods` | tidak ada (daftar kosong) |
| `owner` | pemilik sub-bot (user yang menautkan) **dan** akun sub-bot itu sendiri (`fromMe`) |
| `premium` | `users[…].premium` di database sub-bot |

Founder/owner bot utama **tidak** otomatis memiliki hak di dalam sub-bot. Manajemen sub-bot dari sisi bot utama (stop/hapus/daftar) dilakukan lewat command di bot utama.

Plugin di bot utama: `jadibot/jadibot.js` (`jadibot`, private), `jadibot/stopjadibot.js` (`stopjadibot`, private), `jadibot/deljadibot.js` (`deljadibot`, private; founder/owner boleh untuk id mana pun), `jadibot/listjadibot.js` (`listjadibot`, `handler.owner`).

### 10.9 Plugin sub-bot

- **Template awal** (disalin manager dari `lib/subbot/templates/plugins/` ke `<sandbox>/plugins/`): `main/menu.js`, `info/ping.js`, `info/getlid.js`, `tools/saveplugin.js`, `tools/getplugin.js`, `tools/deleteplugin.js`. Ketiga plugin CRUD memakai `lib/plugins/files.js` (9.10) dengan `root = <sandbox>/plugins`.
- **Semua operasi berkas** melewati `sandboxPath(root, relatif)`: `resolve` + `realpath` harus berada di dalam `root`; tolak `..`, path absolut, nama di luar regex, dan simlink (`lstat`); tolak berkas melebihi `maxPluginKB`; jumlah plugin ≤ `maxPlugins`.
- Hot-reload identik dengan 9.9 tetapi berjalan di proses worker. `saveplugin`/`deleteplugin` memicu reload eksplisit.
- `saveplugin` di sub-bot hanya tersedia bila `global.bots.allowCustomPlugins` bernilai `true` (default `false`, lihat 10.12) atau `'owner-approval'` (Fase 2), dan hanya untuk `owner` sub-bot. `getplugin`/`deleteplugin` selalu hanya untuk `owner` sub-bot.
- Sub-bot boleh mengimpor `#lib` (kode runtime read-only yang tidak menyimpan rahasia). Yang tidak terjangkau: `config.js`, `plugins/` utama, `sessions/`, `databases/` utama, `bots/` lain, dan env bot utama (10.10).
- Template awal **tidak pernah** mencakup `owner/exec.js`, `owner/eval.js`, atau `owner/o.js` (9.12), atau plugin lain yang memakai `child_process`, konstruktor `Function`-like untuk eval, atau sejenisnya. Ini batas keras, bukan default yang bisa dikonfigurasi — lihat gerbang akses di 9.12 dan pemindai kebijakan L6 (10.10).

### 10.10 Sandbox: lapisan dan batas jaminan

| Lapisan | Mekanisme | Yang dijaga | Status |
|---------|-----------|-------------|--------|
| L1 Proses terpisah | Satu proses per sub-bot | `global` dan `process.env` bot utama **tidak terjangkau** (memori terpisah); crash terisolasi; dapat di-kill | ✔ kuat |
| L2 Env minimal | `spawn` dengan `env` eksplisit: `SUBBOT_ID`, `TMPDIR`/`TMP`/`TEMP` = `<sandbox>/tmp`, `TZ`, `NODE_ENV` (+ `SystemRoot` di Windows). Tanpa rahasia | `process.env` | ✔ diuji: child hanya melihat kunci yang diberikan |
| L3 Node Permission Model | `--permission`; `--allow-fs-read` = `[sandbox, <root>/lib, <root>/handler.js, <root>/package.json, <root>/node_modules]`; `--allow-fs-write` = `[sandbox]`; **tanpa** `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi`. `--allow-net` ditambahkan hanya bila dikenali | Berkas di luar sandbox, spawn proses, worker, addon native | ✔ diuji Node 22.22.2: impor Baileys dari `node_modules` dan tulis `auth/` berhasil; baca/tulis di luar, `exec` ditolak (`ERR_ACCESS_DENIED`); IPC tetap jalan. ⚠ hanya "seat belt" |
| L4 Path confinement | `sandboxPath()` untuk semua operasi plugin | CRUD plugin dan penghapusan sandbox | ✔ unit test |
| L5 Capability terbatas | Worker tidak memuat config/plugin utama; global hanya milik sub-bot | Kebocoran secara desain | ✔ |
| L6 Kebijakan plugin (Fase 2) | `acorn`: tolak impor `node:child_process`, `node:worker_threads`, `node:vm`, `node:module`, `node:inspector`; tolak `process.env`, `process.binding`, `process.dlopen`, `eval`, `new Function`, `import()` non-literal; allowlist impor: built-in aman (`node:path`, `node:url`, `node:util`, `node:crypto`, `node:buffer`, `node:stream`, `node:zlib`, `node:fs`, `node:fs/promises`, `node:timers`, `node:events`), paket di `allowedPackages`, path relatif di dalam sandbox, dan `#lib` | Kode kustom dari user | Fase 2; **bukan** batas keamanan, hanya penyaring |
| L7 Watchdog dan kuota (Fase 2) | Heartbeat (kill bila diam 60 detik), `--max-old-space-size=<heapMB>`, batas disk (`maxDiskMB`, diukur berkala), batas jumlah/ukuran plugin | DoS (loop tak berujung, boros memori/disk) | Fase 2 |

Launcher (pseudocode):

```
execArgv = [ permissionFlag, '--allow-fs-read=…' (×5), '--allow-fs-write=<sandbox>',
             (net flag bila dikenali), '--max-old-space-size=<heapMB>' ]
child = fork(<root>/lib/subbot/runtime/worker.js, [<sandbox>],
             { cwd: <sandbox>, env: minimalEnv, execArgv, stdio: ['ignore','pipe','pipe','ipc'], serialization: 'json' })
```

Deteksi flag: `process.allowedNodeEnvironmentFlags.has('--permission')` → pakai itu; bila tidak, coba `'--experimental-permission'` (Node 20 / 22 sebelum 22.13); bila keduanya tidak ada → jalan tanpa L3, cetak peringatan keras, dan **paksa** `allowCustomPlugins = false`. `--allow-net` hanya ditambahkan bila `allowedNodeEnvironmentFlags.has('--allow-net')` ✔ (tidak dikenal di Node 22.22.2; dokumentasi Node 26 membatasi jaringan secara default sehingga flag itu diperlukan di sana).

**Batas jaminan (jujur):**

- Dokumentasi Node menyatakan Permission Model **bukan** perlindungan terhadap kode berbahaya; ia mencegah kode tepercaya mengakses sumber daya tanpa sengaja ✔. Simlink yang sudah ada diikuti keluar batas, deskriptor file yang sudah terbuka melewati model, dan `process._debugProcess(pid)` dapat memaksa proses Node lain pada **OS user yang sama** membuka inspector ✔.
- Akibatnya: **global dan env terjamin terpisah (L1, L2)**; sedangkan **akses berkas dan aksi OS hanya sabuk pengaman (L3–L7)**. Plugin berbahaya yang tekun masih berpotensi menjangkau berkas proyek utama (`config.js`, `sessions/`) karena berjalan sebagai OS user yang sama.
- Karena itu pemilik wajib memutuskan (Bagian 15): (a) `allowCustomPlugins` = `false` (hanya template baku, default) / `'owner-approval'` / `true`; (b) bila sub-bot dibuka untuk publik, jalankan seluruh bot di bawah isolasi OS (container atau OS user terpisah).
- Arsitektur menyediakan titik sambung untuk isolasi OS: `launcher` berbentuk strategi (`node-permission` = default; `external-command` = OPSIONAL, membungkus perintah spawn dengan wrapper container/bubblewrap). Baseline hanya mendefinisikan antarmukanya.

### 10.11 Siklus hidup

- **`stopjadibot`** (pemilik sub-bot): IPC `stop` → worker keluar; status `stopped`; sandbox dipertahankan. **`jadibot` ulang** pada sandbox `stopped` → start tanpa pairing bila `creds.registered`.
- **`deljadibot`** (pemilik atau founder/owner): konfirmasi → IPC `stop` dengan `logout: true` (logout eksplisit dari permintaan user diperbolehkan; ia melepas perangkat tertaut) → kill → hapus sandbox rekursif dengan guard (path hasil `resolve` harus tepat `bots/session@<nomor>` dan lolos regex) → hapus entri registry.
- **`listjadibot`** (owner): daftar id, status, uptime, RSS (dari heartbeat), pemilik.
- **Crash worker:** restart otomatis dengan backoff (5 detik, ×2, maksimum 5 menit). Lebih dari 5 restart per jam ⇒ `failed` + notifikasi ke pemilik sub-bot dan founder.
- **`loggedOut`:** status `logged_out`, hapus `auth/` sandbox itu (sesi sudah tidak valid; ini **satu-satunya** penghapusan otomatis dan hanya untuk sandbox sub-bot), pertahankan `plugins/` dan `databases/`; user dapat `jadibot` lagi. **`connectionReplaced`:** berhenti, status `stopped`, beri tahu pemilik.
- **Boot proses utama:** `restoreAll()` men-spawn worker berurutan dengan jeda `spawnStaggerSec`, maksimum 2 worker berstatus *starting* bersamaan. **Shutdown:** hentikan semua worker (4.2).

### 10.12 Opsi `global.bots` (default)

```js
global.bots = {
  enabled: false,            // dua tingkat: juga butuh settings[botLid].jadibot
  maxBots: 5, maxPerUser: 1,
  pairingTimeoutSec: 120,
  heapMB: 256, spawnStaggerSec: 4,
  allowCustomPlugins: false, // false | 'owner-approval' | true  (10.10)
  maxPlugins: 30, maxPluginKB: 64, maxDiskMB: 100,
  outbound: { perChatMs: 1200, perSecond: 3 },
  allowedPackages: [],       // paket npm yang boleh diimpor plugin sub-bot (L6)
  logRelay: 'masked',
}
```

### 10.13 Fase pengerjaan sub-bot

- **P1 (basis):** manager, launcher, registry, IPC, sandbox + `sandboxPath`, worker, pairing flow, status, stop/delete/restore, template plugin, plugin `jadibot/*` di bot utama, L1–L5.
- **P2 (pengetatan, setelah P1 stabil):** L6 (policy scan), L7 (watchdog, kuota), mode `'owner-approval'`, broker kemampuan.
- **P3 (opsional):** strategi launcher `external-command` untuk isolasi tingkat OS.

---

## 11. `lib/` Modular (Nested Barrel Export)

```
/lib/
├─ index.js                     barrel utama: re-export barrel anak
├─ simple.js  store.js  print.js    CORE: diimpor langsung (#lib/simple.js), bukan lewat barrel
├─ connection/    index.js  …       siklus hidup koneksi (4.3)
├─ identity/      index.js  …       resolver, forAction, validator (Bagian 7)
├─ database/      index.js  engine.js  collections/{index,users,chats,settings,stickers,stats,subbots}.js
├─ plugins/       index.js  loader.js  watcher.js  normalize.js  files.js
├─ subbot/        index.js  manager.js  launcher.js  registry.js  ipc.js  sandbox.js  policy.js  runtime/  templates/
├─ helpers/       index.js  …       lihat tabel
├─ media/         index.js          placeholder; converter.js/upload.js dibuat saat ada plugin yang membutuhkan
└─ scraper/       index.js          placeholder
```

Aturan barrel:

- `lib/index.js` hanya me-re-export barrel anak (`export * from './database/index.js'`, dst.). Setiap folder punya `index.js` yang mengekspor isi foldernya.
- Menambah modul baru = membuat berkas di foldernya + **satu baris** di barrel folder itu; root barrel tidak disentuh.
- Bila dua modul mengekspor nama yang sama, gunakan ekspor bernama eksplisit (bukan `export *`) untuk menghindari konflik.
- File CORE dan modul daun **DILARANG** mengimpor barrel (mencegah dependensi sirkular). Plugin boleh mengimpor `#lib`.

`lib/helpers/`:

| Berkas | Tugas |
|--------|-------|
| `paths.js` | helper pengganti `__filename`/`__dirname` untuk ESM (`global.__filename(import.meta.url)`, `global.__dirname(…)`); OPSIONAL `__require` via `createRequire` untuk paket CJS-only |
| `cache.js` | cache TTL + batas ukuran yang memenuhi `CacheStore` Baileys (`get/set/del/flushAll`, `close`) ✔ |
| `queue.js` | antrean berurutan per kunci (per chat) dengan batas konkurensi global; antrean keluar (12.2) |
| `lock.js` | mutex per kunci untuk baca-ubah-tulis (8.6) |
| `time.js` | pemformat berbasis `Intl` dan `global.timezone`; format durasi |
| `text.js` | utilitas teks dan markup WhatsApp |
| `messages.js` | `dfail` dan teks bawaan (sambutan, notifikasi grup) |
| `api.js` | OPSIONAL: `global.API(nama, path, query, namaKunci)` pembangun URL dari `global.APIs`/`APIKeys` |
| `support.js` | deteksi biner opsional (ffmpeg, dsb.) → `global.support`; tidak crash bila tak ada |
| `silentLogger.js` | objek logger no-op (`level: 'silent'`, `child`, `trace/debug/info/warn/error`) ✔ memenuhi kebutuhan Baileys |
| `prompt.js` | input interaktif (IPC bila ada supervisor, selain itu stdin) |
| `tmp.js` | `ensureDirs()`, pembersihan `tmp/` |
| `redact.js` | redaksi rahasia untuk log dan laporan error |
| `net.js` | validasi URL publik (hanya `http(s)`; tolak loopback, private, link-local, alamat metadata, juga setelah redirect/DNS; batas ukuran, waktu, redirect) untuk plugin yang mengambil URL dari input user |

---

## 12. Keamanan dan Keselamatan Akun

Ringkasan aturan yang **dikunci** (rincian dan alasan ada di `AGENTS.md`).

### 12.1 Rahasia dan sesi

- `sessions/`, `bots/*/auth/`, `config.js`, `.env` adalah rahasia: **DILARANG** di-commit, di-log, dikirim lewat chat, atau disalin ke fixture/dokumen. Auth state setara kunci akses akun WhatsApp.
- Tidak ada penghapusan, penyalinan, atau pemindahan data sesi otomatis, kecuali kasus eksplisit di 10.11. Dua proses **tidak boleh** memakai satu sesi.
- Error dan log melalui `print.redact` sebelum tampil; pesan error ke user tidak boleh memuat stack, path, query, atau kunci.
- Bot utama menjalankan tiga plugin eksekusi kode owner yang disengaja (`owner/exec.js`, `owner/eval.js`, `owner/o.js`; 9.12). Ini membuat identitas founder/owner yang dikonfigurasi (5.1) setara kredensial akses penuh ke host — kompromi sesi/akun salah satu dari mereka setara kompromi server. Keduanya tidak pernah ada di template sub-bot (10.9).

### 12.2 Pengiriman dan batas laju

- Semua pengiriman melewati **satu antrean keluar** per proses: jeda minimum per chat (default 700 ms ± jitter), batas global (default 5 pesan/detik; sub-bot lebih ketat, 10.6), dan cooldown per user/command **sebelum** pekerjaan mahal.
- Pada bot utama, sub-bot, maupun plugin: **DILARANG** broadcast/siaran massal, mention massal dari input user, auto-join/auto-add, auto-reply ke semua chat, dan kirim ke nomor yang belum pernah menghubungi bot. ⚠ Akun perangkat tertaut dapat dibatasi untuk memulai chat dengan kontak baru; rancang fitur sebagai balasan atas pesan masuk.
- **DILARANG** menyusun trafik protokol manual (ack pengiriman, query mentah, patch app-state): ✔ Baileys 7 sengaja berhenti mengirim ack karena akun yang mengirimnya dibanned, dan `chatModify` dengan data tak lengkap dapat memutus semua perangkat tertaut.
- `sock.logout()` hanya untuk fitur yang diminta user secara eksplisit (`deljadibot`).
- Reconnect memakai backoff (4.3); tidak ada loop rapat.

### 12.3 Input tidak tepercaya

- Semua isi dari WhatsApp (teks, caption, nama berkas, media, kutipan, nama grup/kontak, mention, tautan) tidak tepercaya: validasi tipe, format, panjang, dan rentang; batasi ukuran teks, jumlah argumen, jumlah mention, jumlah URL, dan ukuran media.
- **DILARANG** `eval`, `new Function`, `vm`, `import()`/`require` dinamis dari nilai turunan input, dan merangkai string shell dari input (gunakan `execFile`/`spawn` dengan array argumen).
- Path berkas (nama plugin, unduhan, unggahan) di-`resolve` dan dipastikan tetap di direktori tujuan; nama berkas dari user tidak dipakai langsung.
- Output model bahasa atau layanan eksternal yang dipanggil fitur bot juga tidak tepercaya dan tidak boleh memicu command berhak istimewa.

### 12.4 Privasi

- Isi pesan dan metadata hanya di RAM (store); tidak ditulis ke disk. Log console tidak ditulis ke berkas.
- Fitur yang menangkap konten yang tidak ditujukan ke bot (antiDelete, view-once, pencatatan grup, pelacakan presence) wajib opt-in per chat dan berbatas. Di baseline hanya antiDelete (9.8).
- Nomor telepon tidak ditampilkan ke user kecuali fitur membutuhkannya.

### 12.5 Dependensi dan jenis pesan

- Pakai **hanya** paket resmi `@whiskeysockets/baileys`. **DILARANG** menambah atau berpindah ke fork/wrapper/build "mod" atau "pro": mereka berada di antara bot dan sesi dan dapat membocorkan kredensial (kasus nyata: paket `lotusbail`, 2025).
- Tidak ada pesan interaktif/legacy (button, list, template, carousel) di baseline.
- Upgrade Baileys (terutama mayor, mis. ke v8 yang mengubah format auth state) adalah tugas migrasi tersendiri: baca panduan migrasi, cadangkan auth state, uji.

---

## 13. Strategi Pengujian (Tanpa Koneksi WhatsApp)

- Kerangka: `node:test` dan `node:assert` bawaan Node; tanpa dependensi uji.
- `npm test` menjalankan `test.js`: (1) pemeriksa sintaks rekursif untuk semua `.js` di root, `lib/`, `plugins/`, `tests/`, dan template sub-bot memakai `acorn`; (2) `node --test tests/`.
- Alat bantu: `createFakeConn()` (merekam `sendMessage`, `groupParticipantsUpdate`, `readMessages`, dsb.) dan fixture pesan berupa instance `proto.WebMessageInfo` lengkap dengan field alt (teks, grup, kutipan, media, revoke). Waktu dan acak dapat dikontrol.
- **DILARANG** test yang membuka koneksi WhatsApp, jaringan, atau memakai sesi asli.

Cakupan wajib:

| Area | Kasus |
|------|-------|
| `protoType`, `serialize`, `smsg` | helper non-enumerable; getter `chat`/`sender`/`text`/`mtype`/`quoted`; setter `text`; instance dipertahankan dan field alt tidak hilang |
| store | LRU/TTL; pesan keluar tercatat; `getMessage`; dedupe fetch metadata; batas ukuran |
| identity | 10 kasus di 7.7 |
| database | auto-fill (baru/ada/korup), naik versi skema, tulis atomik + `.bak`, berkas korup ⇒ boot dibatalkan, `extend`, `update` dengan mutex |
| pipeline | gerbang G0–G4; urutan A→B→C→D; `before` truthy hanya melewati plugin itu; `all` tidak memblokir; first-fail memo; satu command per pesan; limit hanya terpotong saat sukses; `throw` string vs `Error` |
| parsing | prefix string/array/RegExp; `prefixless` + `command` match-all (termasuk auto-fill); baris baru di `text` dipertahankan; `command` array |
| izin | tiap flag lulus/gagal; hierarki peran; `fromMe`; `admin` tanpa bypass; `game`/`nsfw` hanya di grup; `rpg` |
| event grup | welcome/bye/detect; `participants` berupa objek; throttle; mode `self` |
| `deleteUpdate` | 4 kasus di 9.8 |
| loader | normalisasi; alias legacy; sintaks salah ⇒ versi lama bertahan; reload eksplisit; remove; duplikat command |
| file plugin | sanitasi nama; tag pertama; pindah folder; ambiguitas; traversal dan simlink ditolak |
| koneksi | tabel reconnect (4.3) memakai fake socket/state machine; satu socket; reset backoff |
| sub-bot | `sandboxPath`; validasi IPC; kuota dan rate limit; launcher menyusun argv/env benar + deteksi flag; registry; hapus sandbox aman |
| config, print | validasi config; redaksi rahasia |

**Checklist uji manual di perangkat asli (⚠ dilakukan pemilik, hasilnya dicatat):**

1. Pairing bot utama (kode kustom dan acak) dan transisi `restartRequired` → `open`.
2. Command di private dan grup; `register`, `limit`, `premium`, `admin`, `botAdmin`.
3. Mention dengan nomor ketik `08…` dan `@tag` di grup beralamat LID; kick/promote/demote/add (cek perilaku fallback PN/LID).
4. Welcome, bye, detect; antiDelete menyala/mati.
5. Hot-reload: `saveplugin` dan `deleteplugin` tanpa restart.
6. Sub-bot: pairing, command dasar, stop, start ulang, hapus; dua sub-bot: folder dan database terisolasi.
7. Sandbox: plugin uji mencoba membaca `../../config.js`, `process.env`, dan `child_process` ⇒ ditolak.
8. Restart proses utama memulihkan sub-bot aktif tanpa `connectionReplaced`.
9. Bot utama dan sub-bot di grup yang sama tidak saling membalas.
10. Memori stabil setelah 24 jam (termasuk setelah banyak reload plugin).

---

## 14. Rencana Pengerjaan (Milestone)

Kerjakan berurutan; tiap milestone ditutup dengan tes hijau dan laporan sesuai `AGENTS.md`.

| M | Cakupan | Selesai bila |
|---|---------|--------------|
| M0 | Kerangka: `package.json` (alias `#lib`, engines), `.npmrc`, `.gitignore`, validasi config, helpers dasar, `test.js` | `npm test` berjalan; config tidak valid ditolak dengan pesan jelas |
| M1 | `simple.js` (`protoType`, `serialize`, `smsg`, method `conn`), `print.js`, `store.js` | Tes `protoType`/`serialize`/`smsg`/store/print hijau; tidak ada penugasan eager `m.chat = …` |
| M2 | `lib/identity` + `lib/database` (engine, collections, auto-fill, persistensi atomik) | 10 kasus identity dan seluruh kasus database hijau; berkas korup membatalkan boot |
| M3 | `lib/connection` + `index.js` + `main.js` (boot, shutdown, pairing, kebijakan reconnect) | Tabel reconnect lulus pada fake socket; shutdown tidak memanggil `logout` |
| M4 | `handler.js` (pipeline), loader plugin + hot-reload, `dfail`, event grup, `deleteUpdate`, plugin referensi (9.11), tiga plugin owner wajib (9.12) | Seluruh kasus pipeline/parsing/izin/event/`deleteUpdate` hijau; `exec.js`/`eval.js`/`o.js` termuat tanpa error lewat loader (hasil dilaporkan apa adanya, termasuk bila ada yang gagal) |
| M5 | `lib/plugins/files.js` + `saveplugin`/`getplugin`/`deleteplugin` (bot utama) | Tes file plugin hijau; reload terpicu eksplisit |
| M6 | Jadibot P1 (10.13) | Tes sandbox/IPC/manager/launcher hijau; worker lolos self-check pada lingkungan uji |
| M7 | Jadibot P2 (pengetatan) | Policy scan, watchdog, kuota, mode persetujuan berfungsi di tes |
| M8 | Akseptasi di perangkat asli (checklist 13) oleh pemilik | Checklist terisi; temuan ⚠ dicatat |

---

## 15. Asumsi dan Keputusan Terbuka

Default di bawah dipilih agar aman dan konsisten. Pemilik dapat mengubahnya; agent **jangan** mengubahnya sendiri.

1. **`allowCustomPlugins` = `false`** di sub-bot (konservatif). Fitur `saveplugin` sub-bot dibangun penuh, tetapi aktif setelah pemilik menyetel `true`/`'owner-approval'`.
2. **Isolasi OS** untuk sub-bot publik (container atau OS user terpisah) sangat dianjurkan tetapi tidak diimplementasikan di baseline (10.10).
3. ⚠ **Bentuk id untuk aksi grup** (`groupParticipantsUpdate`) dan **bentuk mention**: default PN dengan fallback sekali ke LID; perlu diuji di perangkat asli.
4. **`chats.isBanned` default `false`.** Bila menginginkan mode "chat baru nonaktif sampai diaktifkan", ubah di `collections/chats.js`.
5. **`game`/`nsfw` hanya diperiksa di grup**; **`rpg` wajib grup**; **`admin` tanpa bypass owner.** (Asumsi perilaku; ubah di 9.2 bila tidak sesuai.)
6. **`before` truthy hanya melewati command plugin itu**, bukan seluruh pipeline (9.3).
7. **Chat/user banned menghentikan seluruh pipeline** (termasuk hook) untuk non-owner (9.4, G4).
8. **Nomor jadibot harus milik pengirim** kecuali owner/founder (10.4) sebagai pencegah penyalahgunaan notifikasi pairing.
9. **Bot utama dan sub-bot di grup yang sama akan sama-sama menanggapi command manusia.** Belum ada konsep "bot utama per grup".
10. **Data lama tidak dimigrasi.** Bila diperlukan, buat alat terpisah; kunci nomor telepon lama harus dipetakan ke LID.
11. **Node ≥ 22.13.** Host dengan Node lebih lama tidak didukung baseline.
12. **Baileys `7.0.0-rc14` adalah pre-release.** Dipin persis; jangan upgrade tanpa tugas migrasi (v8 sedang dikembangkan dengan format auth state baru).
13. **Lisensi `cfonts` (GPL-3.0-or-later)** perlu dipertimbangkan bila proyek didistribusikan; banner dapat diganti teks biasa tanpa dampak fungsi.
14. **Bahasa:** teks untuk user dalam Bahasa Indonesia, terpusat di `lib/helpers/messages.js`; komentar kode bebas.
15. **Laporan error ke founder lewat DM** (throttle 1/menit/plugin); dapat diganti menjadi log saja.
16. **Jarak waktu dan batas default** (cooldown, ukuran cache, TTL, rate limit) adalah titik awal yang konservatif; ubah lewat config bila perlu.
17. **Login bot utama: pairing code adalah default**, QR code adalah opsi (4.3), sesuai permintaan eksplisit pemilik. Jadibot tetap pairing-only (10.4), tidak terpengaruh.
18. **`global.conn`** adalah global baru (4.2) yang hanya ada demi kompatibilitas verbatim `owner/eval.js` (9.12). Bila kelak `eval.js` dihapus/diganti, `global.conn` boleh ikut dihapus — bukan bagian inti arsitektur.
19. **`src/config/` tidak digitignore secara default** (3.1), berbeda dari `src/public/`/`src/private/`. Ini tebakan konservatif (menyamakan dengan pola `config.example.js` yang dikomit), bukan kepastian — tujuan folder ini sendiri belum ditentukan pemilik.
20. ⚠ **`handler.group = false` pada `owner/o.js`** (9.12) diperlakukan sebagai "tanpa syarat grup" di bawah kontrak gerbang baru (sama seperti tidak mendeklarasikannya). Perlu dikonfirmasi saat migrasi apakah ini perilaku yang diharapkan pemilik, karena isi `owner-o.js` sendiri tidak menyatakan maksud nilai `false` eksplisit tersebut.

---

## Lampiran: Glosarium

| Istilah | Arti |
|---------|------|
| **PN / JID nomor** | ID akun berbasis nomor telepon, `628…@s.whatsapp.net` |
| **LID** | ID akun alternatif/kanonik WhatsApp, `…@lid`; tidak mengungkap nomor telepon |
| **Peers** | Himpunan identitas semua bot milik sistem ini (utama + sub-bot) |
| **Sub-bot** | Akun WhatsApp user yang ditautkan lewat pairing dan dijalankan sebagai bot dalam sandbox |
| **Sandbox** | Folder `bots/session@<nomor>/` + proses worker terisolasi |
| **Store** | Memori sementara bot: pesan terbaru, metadata grup, nama kontak (6.5) |
| **Barrel** | `index.js` yang me-re-export isi sebuah folder |
| **Hot-reload** | Memuat ulang plugin yang berubah tanpa restart proses |
| **Seat belt** | Pengaman terhadap kecelakaan oleh kode tepercaya; bukan batas keamanan terhadap kode berbahaya |
