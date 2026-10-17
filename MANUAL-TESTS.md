# Checklist perangkat — belum diverifikasi

Semua baris di bawah masih menunggu pengujian oleh pemilik. Jangan menandai selesai berdasarkan unit test.

| Skenario | Langkah dan hasil yang diharapkan | Status |
| --- | --- | --- |
| Pairing utama | Login default dengan kode acak, lalu kode kustom; restartRequired berujung open | Belum diuji |
| QR utama | Pilih QR; nomor tidak diminta; QR baru dirender saat kedaluwarsa; pindai sampai open | Belum diuji |
| Private/grup | `.ping`, `.menu`, `.register Nama.20`; permission dan pesan gagal sesuai peran | Belum diuji |
| Identitas | `.getlid` pengirim, reply, mention dan nomor 08…; LID tidak ditampilkan sebagai nomor telepon | Belum diuji |
| Aksi grup | Dengan plugin uji milik owner, remove/promote/demote/add memakai PN; jika gagal mencoba LID satu kali; periksa status akhir | Belum diuji |
| Mention | PN default; uji mentionForm lid dan auto pada grup beralamat LID | Belum diuji |
| Welcome/detect | Aktifkan setting, tambah/keluarkan/promote/demote peserta; perubahan subject/desc/icon/undangan; tidak banjir | Belum diuji |
| AntiDelete | Flag mati tidak resend; hidup mengembalikan satu pesan tersimpan; edit tidak memicu; bot yang menghapus tidak resend | Belum diuji |
| Hot reload | Save/get/delete plugin, ubah kategori; perintah berubah tanpa restart; sintaks salah mempertahankan versi lama | Belum diuji |
| Jadibot | Aktifkan dua tingkat, pairing akun sendiri, `.ping` sub-bot, stop, start ulang, delete dengan konfirmasi | Belum diuji |
| Dua sub-bot | Sesi, database, peran, plugin dan src terpisah; owner utama tidak otomatis owner sub-bot | Belum diuji |
| Worker sandbox | Percobaan baca config utama, env, import child_process ditolak pada jalur plugin | Belum diuji |
| Restore | Restart utama; worker aktif pulih, yang stopped tetap berhenti; tidak ada connectionReplaced | Belum diuji |
| IPC putus | Hentikan proses utama secara mendadak; worker keluar dan tidak menjadi yatim | Belum diuji |
| Peer bot | Utama dan sub-bot di grup yang sama tidak membalas pesan bot satu sama lain | Belum diuji |
| Penghapusan offline | Del sesi stopped terdaftar membuka koneksi lalu logout; kegagalan logout menyisakan data | Belum diuji |
| Ketahanan | Jalankan 24 jam; catat RSS, reconnect, antrean dan jumlah reload plugin | Belum diuji |

Catat tanggal, versi Node, OS, versi aplikasi WhatsApp dan hasil aktual saat mengisi checklist. Jangan lampirkan auth, pairing code, nomor pribadi, isi chat atau secret dalam laporan yang dibagikan.
