# Sailox WhatsApp Bot

Implementasi blueprint bot Node.js ESM dengan Baileys resmi **7.0.0-rc14**. Termasuk bot utama, login pairing/QR, identitas LID, JSON per collection, pipeline plugin, hot-reload, dan jadibot dengan worker terpisah.

## Mulai

Butuh Node.js **22.13 atau lebih baru**; proyek diverifikasi dengan Node **24.19.0** dan npm **11.9.0**. Gunakan hanya satu instance untuk satu sesi.

1. Ekstrak paket dan buka terminal di folder `whatsapp-bot`.
2. Jalankan `npm ci` untuk memasang versi dari lockfile.
3. Salin `config.example.js` menjadi `config.js` (Linux/macOS: `cp config.example.js config.js`; PowerShell: `Copy-Item config.example.js config.js`).
4. Isi `global.founder`/`global.owner` sesuai akun yang berhak. Format tiap entri: `["nomor E.164 tanpa +", "digit LID atau kosong", "nama"]`. Biarkan array peran kosong jika tidak dipakai. `global.mods = []`, bukan `[[]]`.
5. Jalankan `npm test`. Tes tidak membuka koneksi WhatsApp dan tidak memakai sesi asli.
6. Jalankan `npm start`. Pilih `1` untuk pairing (default), atau `2` untuk QR. Saat pairing, isi nomor bot bila belum disetel di config.
7. Tautkan lewat WhatsApp → Perangkat tertaut → Tautkan perangkat. Untuk pairing, pilih tautkan dengan nomor telepon lalu masukkan kode. Untuk QR, pindai kode di terminal.
8. Setelah status `open`, kirim `.ping` dan `.menu` dari akun yang berhak. Hentikan dengan Ctrl+C; sesi tetap tersimpan.

Alternatif noninteraktif: `npm start -- --login pairing --phone <digit-nomor>` atau `npm start -- --login qr`. Pengoperasian bot dan penautan perangkat belum diuji dengan WhatsApp asli; isi checklist di `MANUAL-TESTS.md`.

## Command

| Command | Akses / fungsi |
| --- | --- |
| `.menu [kategori]`, `.help` | Daftar command berdasarkan help/tags |
| `.ping`, `.uptime` | Respons dan uptime |
| `.register Nama.20`, `.daftar Nama.20` | Pendaftaran |
| `.getlid [nomor/mention]` | LID/JID pengirim atau target; balasan/mention didahulukan |
| `.saveplugin nama` | Owner; balas kode atau lampiran `.js`, atau taruh kode sesudah nama |
| `.getplugin nama`, `.deleteplugin nama` | Owner; dukung `kategori/nama` untuk pencarian |
| `.banuser target`, `.unbanuser target` | Owner; target harus terpetakan ke LID |
| `.banchat`, `.unbanchat` | Owner; di grup yang akan diubah |
| `.self`, `.public` | Owner; mode tersimpan per bot |
| `.setprefix !`, `.setprefix reset` | Owner; ubah/reset prefix |
| `.setting fitur on/off` | Untuk fitur grup: admin grup/owner; pengaturan bot: owner |
| `.setcmd perintah` | Owner; balas stiker untuk mendaftarkan pemicu command |
| `.jadibot nomor` | Private; menautkan akun sendiri sebagai sub-bot |
| `.stopjadibot [nomor/id]` | Private; pemilik sub-bot |
| `.deljadibot [nomor/id] konfirmasi` | Private; pemilik sub-bot atau owner bot utama |
| `.listjadibot` | Owner bot utama; daftar status, pemilik, uptime dan RSS |
| `.approveplugin session@nomor requestId konfirmasi` | Owner bot utama, private; persetujuan plugin sub-bot setelah meninjau kode |
| `> kode`, `=> ekspresi`, `$ perintah` | Founder; plugin eksekusi asli dipertahankan verbatim |
| `.o kode` | Owner; menjalankan script berdasarkan deteksi bahasa asli |

`.setting` mendukung fitur grup `welcome`, `detect`, `delete` (antiDelete), `antiLink`, `game`, `rpg`, `nsfw`; pengaturan bot `jadibot`, `autoread`, `pconly`, `gconly`. Fitur opt-in default mati. Anti-link adalah contoh moderasi: menghapus tautan undangan jika bot admin, tanpa kick otomatis. Flag game/RPG/NSFW adalah gerbang; tidak ada game atau ekonomi di baseline.

Owner utama tidak melewati syarat admin grup pada plugin dengan `handler.admin`. `fromMe` menjadi founder di bot utama dan owner di sub-bot. Pengirim dari peer bot diabaikan agar tidak membentuk loop.

## Jadibot

Aktifkan `global.bots.enabled = true` di `config.js`, restart, lalu sebagai owner kirim `.setting jadibot on`. User mengirim `.jadibot nomor-sendiri` lewat private. Bot hanya menerima nomor yang sama dengan PN pengirim, kecuali owner utama. Jika PN belum diketahui, permintaan ditolak.

Setiap sesi memakai `bots/session@<nomor>/`: auth, database, plugin, src dan tmp sendiri. Maksimum default 5 sesi, 1 per user; pairing maksimum 3 percobaan/jam/user dan sekali/5 menit/nomor selama proses hidup. Worker memiliki heap cap, heartbeat, kuota disk, dan IPC terbatas. Sub-bot berhenti jika IPC utama putus.

Stop menyimpan sesi. Menjalankan jadibot kembali pada sesi stopped yang terdaftar tidak memerlukan pairing. Menghapus membutuhkan `konfirmasi`, menjalankan logout yang terkonfirmasi, lalu menghapus sandbox. Jika logout tidak berhasil, data dipertahankan. Penghapusan sesi offline yang masih terdaftar mencoba membuka worker terlebih dahulu; jika jaringan/akun bermasalah, perintah gagal tanpa menghapus data. Status logged_out hanya membersihkan auth sub-bot yang sudah tidak valid, sesuai blueprint. Timeout pairing tidak menghapus sesi yang sudah terdaftar.

Shutdown bot utama menyimpan niat restore untuk worker aktif. Boot selanjutnya memulihkannya bertahap, maksimal dua worker berstatus starting sekaligus. Sesi yang dihentikan lewat `.stopjadibot` tetap stopped.

### Plugin sub-bot

Template awal hanya menu, ping, getlid, dan CRUD plugin owner sub-bot. Tiga plugin eksekusi utama **tidak** disalin.

`allowCustomPlugins` default `false`. Nilai global menjadi kebijakan awal untuk sesi baru; kebijakan per sesi disimpan di registry utama `subbots.json`. Perubahan kebijakan untuk sesi lama harus dilakukan operator pada registry ketika bot berhenti, lalu restart; jangan mengubah database runtime secara bersamaan dengan proses hidup. Mengatur global ke false adalah batas tambahan yang mematikan plugin kustom untuk seluruh sesi.

Mode `'owner-approval'`: `.saveplugin` menyimpan permintaan di `bots/session@N/src/plugin-requests/<requestId>.json`. Operator meninjau `name`, `code`, dan hash di host; setelah sesuai, jalankan `.approveplugin session@N requestId konfirmasi` pada bot utama. Kode dipindai lagi dan hash persetujuan disimpan di registry utama. Bot utama tidak mengimpor kode itu. Worker aktif direstart agar menerima kebijakan baru. Dependensi lokal perlu ikut disetujui; semua dependensi JS lokal dipindai sebelum import.

Mode `true` tetap memakai pemindai kebijakan. Pemindai menolak child_process, worker_threads, vm, module, inspector, env, binding, konstruktor dinamis, match-all tertentu, dan import dinamis nonliteral. Beberapa pola JS sah (misalnya properti computed dinamis) sengaja ditolak. Error loader mempertahankan plugin lama yang masih valid.

**Batas sandbox:** proses dan env terpisah. Node Permission Model dan scan AST adalah pengaman untuk kode tepercaya; bukan jaminan terhadap plugin berbahaya. Jangan membuka plugin publik tak tepercaya tanpa isolasi OS/container/user terpisah. Strategi launcher container dan capability broker opsional tidak disertakan.

## Konfigurasi dan lingkungan

Konfigurasi bot ada di `config.js`; tidak dibaca dari `.env` secara otomatis. Template berisi semua default blueprint. `logPrivacy` dipilih `masked` mengikuti prioritas privasi AGENTS.md. Gunakan `full` hanya jika operator sengaja membutuhkan isi pesan di console. Log tidak ditulis ke disk. Pesan disimpan hanya di RAM (5000 pesan/6 jam secara default); antiDelete hanya dapat mengembalikan pesan yang masih ada di store dan dibatasi 3 resend/chat/menit.

| Variabel environment | Fungsi |
| --- | --- |
| `BOT_LOGIN_METHOD` | `pairing` atau `qr` bila argumen `--login` tidak diberikan |
| `SETUP_PASSWORD` | Gerbang setup saat `sessions/creds.json` belum ada; kosong = nonaktif |
| `SETUP_INPUT_PASSWORD` | Jawaban gerbang pada host noninteraktif; opsional pada terminal interaktif |
| `PORT`, `SERVER_PORT` | Port health supervisor, fallback 3000 |
| `HEALTH_HOST` | Default `127.0.0.1`; atur eksplisit jika memerlukan antarmuka lain |
| `HEALTH_TOKEN` | Token minimal 16 karakter untuk `Authorization: Bearer …`; tanpa token semua request ditolak |

Health hanya menjawab `GET /` setelah autentikasi, dengan teks `OK`; ini membuktikan supervisor hidup, bukan keterhubungan WhatsApp. Jangan taruh token/password asli dalam source atau shell history bersama.

`src/public`, `src/private` dan semua subfolder sesuai blueprint dibuat kosong saat boot. `src/config` hanya scaffolding, tidak memiliki loader atau server aset. `lib/media` dan `lib/scraper` hanya barrel placeholder sampai ada plugin yang membutuhkannya.

## Mengembangkan plugin

```js
let handler = async (m, { text }) => {
  await m.reply(text || 'Halo!')
}
handler.help = ['echo <teks>']
handler.tags = ['tools']
handler.command = /^echo$/i
handler.limit = 1
export default handler
```

Simpan di `plugins/tools/echo.js`, atau gunakan `.saveplugin echo`. Import selalu di atas. Method pesan/socket memakai descriptor map; getter tidak perlu disalin ulang per pesan. Hook `all` dapat menimpa `m.text`; semua `all` berjalan sebelum semua `before`; `before` truthy hanya melewati command milik plugin itu. Maksimal satu command dijalankan. Limit dan exp berubah hanya setelah sukses; stats menghitung satu kali. Prefixless mendukung command regex match-all demi plugin owner legacy.

Kode inti menggunakan alias `#lib/*`; core simple/store/print diimpor langsung. Modul daun tidak mengimpor barrel. Untuk collection baru, tambahkan deskriptor di `lib/database/collections` dan ekspor dari barrel-nya. Database melakukan autofill, migrasi versi, deteksi perubahan, penulisan atomik, dan satu cadangan `.bak`. Jika berkas utama dan cadangannya korup, boot dibatalkan.

Owner executors dipertahankan tanpa perbaikan internal sesuai syarat migrasi: eksekusi bersifat sangat berhak; `.o` memakai nama berkas tmp tetap dan tidak aman untuk pemanggilan bersamaan. Interpreter Python/PHP/Java/C++ opsional memerlukan binary sistem. Tidak ada ketiga executor itu di sub-bot. Hanya berikan identitas founder/owner kepada akun yang memang memiliki hak host.

## Verifikasi dan sumber

Lihat `IMPLEMENTATION-REPORT.md` untuk hasil tes dan keputusan implementasi, serta `MANUAL-TESTS.md` untuk checklist perangkat. Hasil tes fake socket tidak membuktikan pengiriman/rendering WhatsApp atau perilaku server.

- [Baileys resmi](https://github.com/WhiskeySockets/Baileys), API diverifikasi juga dari paket/type definitions yang terpasang.
- [Node.js Permission Model](https://nodejs.org/download/release/v24.19.0/docs/api/permissions.html).
- `BLUEPRINT.md` dan `AGENTS.md` adalah spesifikasi yang disertakan.

Dependensi dipin lewat package-lock.json; cfonts berlisensi GPL-3.0-or-later sebagaimana dicatat blueprint. `node_modules`, config pribadi, database runtime, auth, tmp dan log tidak disertakan dalam paket sumber. Proyek ini belum dikomit atau dipush ke repository mana pun.
