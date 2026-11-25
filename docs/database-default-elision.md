# Database Default-Elision — Rencana (belum diputuskan)

> Status: **RENCANA SAJA**. Veo (2026-11-25): jangan diimplementasikan dulu,
> simpan saja rencananya di sini. Konsep awal dari teman Veo, disampaikan
> Veo 2026-10-29.

## Konsep

Jangan simpan field yang nilainya masih sama dengan default-nya. Tujuannya
mengecilkan database (terutama `users.json`) tanpa mengubah perilaku bot
yang terlihat dari plugin.

## Desain yang disepakati (bila suatu saat diimplementasikan)

- Elision **HANYA saat serialisasi** (ketika record ditulis ke disk).
  In-memory record selalu lengkap; kontrak plugin tidak berubah.
- Jangan pernah menggantungkan logika pada `undefined` — kode yang membaca
  field harus tetap mendapat nilai default seperti sekarang.
- Opt-in per collection; cakupan awal hanya `users`.
- Version bump pada deskriptor collection saat elision diaktifkan, supaya
  record lama tetap terbaca (fillMissing mengisi yang hilang seperti biasa).
- **Keep-list — JANGAN PERNAH di-elide** (tambahan Veo):
  `lid`, `jid`, `name`, `registered`, `regTime`, `limit`.

## Pengukuran

Dengan keep-list di atas, ukuran `users.json` terukur turun dari
**42.953 byte menjadi 21.303 byte (−50%)**.

## Yang belum diputuskan

- Apakah elision jadi diimplementasikan atau tidak (Veo belum memutuskan).
- Bila ya: kapan, dan apakah cakupan tetap `users` saja atau meluas.
