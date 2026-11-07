# Anime Sequel Title Parser

## 1. Tujuan

`parser.js` mengidentifikasi **indikator sekuel yang secara eksplisit disetujui** dari judul anime atau nama file media. Parser tidak mencoba menebak relasi franchise, prequel, alternate version, atau season berdasarkan pengetahuan eksternal.

Hasil utama:

- `isSequel: true`: setidaknya satu pola sekuel yang diterima ditemukan.
- `isSequel: false`: tidak ada pola sekuel yang diterima ditemukan.
- `status`: membedakan hasil positif dan tidak ditemukannya pola.

**Penting:** `isSequel: false` hanya berarti tidak ada indikator dari daftar ini. Itu bukan bukti bahwa anime tersebut benar-benar seri pertama dalam franchise. Karena itu, keputusan akhir pemberian label `[NEW]` tetap menjadi tanggung jawab sistem renamer.

## 2. Batasan dan keputusan eksplisit

Parser hanya menerapkan pola yang disetujui. Parser tidak boleh memperluas cakupan dengan tebakan kontekstual.

Pola yang sengaja tidak didukung:

- `S 2` (spasi antara `S` dan angka).
- `II Season` (angka Romawi sebelum kata `Season`).
- Penomoran Jepang seperti `Dai 2 Ki`, `Dai-ni-ki`, dan variasinya.
- Sekuel yang hanya ditandai tanda baca/simbol atau perubahan nama tanpa nomor.
- Kata `Final` sendirian. Hanya `The Final` dan `Final Season` yang diterima.
- Nomor Romawi `I` serta angka Romawi di atas `XXX`.
- Angka Romawi atau angka Arab yang berada di tengah judul, kecuali tepat sebelum tanda titik dua (`:`).

## 3. Konstanta pemetaan

Semua pemetaan diletakkan di dalam `PARSER_CONSTANTS` pada `parser.js`.

### 3.1 Angka Romawi

Rentang yang diterima adalah II–XXX:

| Nilai | Romawi | Nilai | Romawi | Nilai | Romawi |
|---:|:---:|---:|:---:|---:|:---:|
| 2 | II | 12 | XII | 22 | XXII |
| 3 | III | 13 | XIII | 23 | XXIII |
| 4 | IV | 14 | XIV | 24 | XXIV |
| 5 | V | 15 | XV | 25 | XXV |
| 6 | VI | 16 | XVI | 26 | XXVI |
| 7 | VII | 17 | XVII | 27 | XXVII |
| 8 | VIII | 18 | XVIII | 28 | XXVIII |
| 9 | IX | 19 | XIX | 29 | XXIX |
| 10 | X | 20 | XX | 30 | XXX |
| 11 | XI | 21 | XXI | | |

### 3.2 Ordinal bahasa Inggris

Rentang yang diterima adalah `Second` sampai `Thirtieth`:

| Nilai | Ordinal | Nilai | Ordinal | Nilai | Ordinal |
|---:|---|---:|---|---:|---|
| 2 | Second | 12 | Twelfth | 22 | Twenty-second |
| 3 | Third | 13 | Thirteenth | 23 | Twenty-third |
| 4 | Fourth | 14 | Fourteenth | 24 | Twenty-fourth |
| 5 | Fifth | 15 | Fifteenth | 25 | Twenty-fifth |
| 6 | Sixth | 16 | Sixteenth | 26 | Twenty-sixth |
| 7 | Seventh | 17 | Seventeenth | 27 | Twenty-seventh |
| 8 | Eighth | 18 | Eighteenth | 28 | Twenty-eighth |
| 9 | Ninth | 19 | Nineteenth | 29 | Twenty-ninth |
| 10 | Tenth | 20 | Twentieth | 30 | Thirtieth |
| 11 | Eleventh | 21 | Twenty-first | | |

Bentuk `Twenty-first` dan seterusnya juga menerima spasi: `Twenty first`, `Twenty second`, dan seterusnya. Pencocokan tidak membedakan kapitalisasi.

## 4. Pola yang diterima

### 4.1 Explicit season indicator

| Bentuk | Contoh | Hasil |
|---|---|---|
| `S` langsung diikuti angka | `Anime S2`, `Anime S3` | Sequel |
| `Season` + angka | `Anime Season 2` | Sequel |
| ordinal angka + `Season` | `Anime 2nd Season`, `Anime 3rd Season`, `Anime 4th Season` | Sequel |
| ordinal kata + `Season` | `Anime Second Season`, `Anime Third Season` | Sequel |

`S 2` tidak diterima. `Season 1` tidak dianggap sequel karena angka yang diterima harus minimal 2.

### 4.2 Roman numeral season indicator

`Season` yang diikuti angka Romawi II–XXX diterima, misalnya:

- `Anime Season II`
- `Anime Season III`
- `Anime Season IV`
- `Anime Season XXX`

Bentuk terbalik seperti `II Season` tidak diterima.

### 4.3 Standalone Roman numeral

Angka Romawi II–XXX diterima hanya dalam salah satu dari dua posisi berikut:

1. **Di akhir judul**, setelah ekstensi media yang dikenal dihapus.
2. **Tepat sebelum titik dua (`:`)**, meskipun masih ada subtitle setelahnya.

Contoh yang diterima:

- `Sailox The Animation II`
- `Sailox The Animation IV.mp4`
- `Mushoku Tensei III: Isekai Ittara Honki Dasu`

#### Perbedaan “akhir judul” dan “akhir string”

Akhir string adalah karakter terakhir dari input mentah. Akhir judul adalah karakter terakhir dari bagian nama file yang merepresentasikan judul, sebelum ekstensi media.

Karena itu:

- `Sailox The Animation IV` → `IV` berada di akhir judul.
- `Sailox The Animation IV.mp4` → `IV` tetap berada di akhir judul setelah `.mp4` dilepas, sehingga diterima.
- `Sailox The Animation IV.mkv` → juga diterima.
- `Sailox The Animation IV [1080p].mkv` → tidak diterima oleh aturan suffix ini, karena setelah ekstensi dihapus, `[1080p]` masih berada setelah `IV`.

Parser hanya menghapus ekstensi video yang tercantum di `PARSER_CONSTANTS.mediaExtensions`. Parser tidak menghapus tag kualitas, codec, release group, atau teks tambahan lain.

### 4.4 Arabic numeral sebagai suffix

Aturannya sama dengan standalone Roman numeral, tetapi tokennya berupa angka Arab dan nilainya minimal 2.

Contoh:

- `Anime 2`
- `Anime 3.mp4`
- `Anime 4: New Beginning`

Angka tidak dibatasi sampai 30. Konsekuensinya, angka seperti tahun atau nomor lain yang diletakkan di akhir judul juga dapat terdeteksi; parser tidak membuat tebakan kontekstual untuk membedakannya.

### 4.5 Written number / English ordinal

Ordinal `Second`–`Thirtieth` diterima dalam bentuk:

- Sebelum marker: `Second Season`, `Third Part`, `Twenty-first Arc`.
- Setelah marker: `Season Second`, `Part Third`, `Cour Twenty-first`.
- Sebagai suffix judul: `Anime Second`, `Anime Twenty-first`.
- Dengan `The` sebagai bagian suffix: `Anime The Second`.
- Tepat sebelum titik dua: `Anime Second: New Beginning`, `Anime: The Third`.

Ordinal `First` tidak termasuk karena daftar dimulai dari `Second`.

### 4.6 Part, Arc, dan Cour

`Part`, `Arc`, dan `Cour` diperlakukan seperti `Season` untuk penomoran: marker diikuti angka, angka Romawi, atau ordinal kata; bentuk ordinal angka/kata sebelum marker juga diterima.

Contoh:

- `Anime Part 2`
- `Anime Arc 3`
- `Anime Cour 2`
- `Anime Part II`
- `Anime Third Arc`
- `Anime 2nd Part`

Pola tersebut menandakan adanya bagian/urutan lanjutan, tetapi tidak otomatis diartikan sebagai `seasonNumber`. Hasil tetap mencatat jenis marker yang ditemukan.

### 4.7 Final indicators

Hanya dua frasa berikut yang diterima, tanpa mensyaratkan angka:

- `The Final`
- `Final Season`

Keduanya memiliki prioritas tertinggi dan selalu dianggap indikator sequel. Kata `Final` saja tidak diterima.

## 5. Pola posisi suffix dan batas token

Untuk standalone Roman numeral, Arabic numeral, dan English ordinal:

- Token harus berdiri sendiri, bukan bagian dari kata yang lebih panjang.
- Token harus berada di akhir judul setelah ekstensi media dilepas, atau tepat sebelum `:`.
- Kapitalisasi tidak sensitif.
- Pemisah sebelum token dapat berupa spasi atau separator judul umum (`.`, `_`, `-`, `–`, `—`, `:`).

Tidak ada pengecualian berdasarkan konteks seperti `Chapter`, `World War`, atau `Type`. Jika token memenuhi aturan posisi yang telah disepakati, token tersebut akan terdeteksi. Ini disengaja agar parser tidak menebak makna judul.

## 6. Arsitektur kode

`parser.js` dibagi menjadi beberapa bagian:

1. **`PARSER_CONSTANTS`** — pemetaan Romawi, ordinal Inggris, ekstensi media, marker, dan frasa final.
2. **Pattern builder** — menyusun regex dari konstanta, mengurutkan alternatif terpanjang lebih dulu, dan menghindari daftar regex yang diduplikasi.
3. **Input preparation (`getInputParts`)** — mengambil basename dari path, mengenali ekstensi video yang didukung, lalu memisahkan `filename`, `title`, dan `extension`.
4. **Value parser (`parseSequenceValue`)** — mengubah angka Arab, angka ordinal, Romawi, dan ordinal Inggris menjadi angka.
5. **Matcher (`collectMatches`)** — mengumpulkan semua indikator yang cocok tanpa mengubah judul asli.
6. **Decision/output (`parseAnimeTitle`)** — menyusun hasil, memilih indikator utama menurut prioritas, dan menentukan `isSequel`.

Tidak ada dependency eksternal. File memakai ES Module, sesuai `"type": "module"` pada `package.json`.

## 7. Prioritas indikator

Jika satu judul memiliki lebih dari satu indikator, semua temuan tersedia pada `matches`. `indicator` adalah temuan utama menurut urutan berikut:

1. `The Final` / `Final Season`.
2. Marker `Season` eksplisit.
3. `S2`, `S3`, dan seterusnya.
4. `Part`, `Arc`, atau `Cour`.
5. Standalone Roman numeral.
6. Standalone Arabic numeral.
7. Standalone English ordinal.

`confidence` adalah skor prioritas heuristik, **bukan probabilitas statistik**.

## 8. Bentuk hasil

Contoh:

```js
import { parseAnimeTitle } from './parser.js'

const result = parseAnimeTitle('Mushoku Tensei III: Isekai Ittara Honki Dasu.mp4')
```

Bentuk hasil:

```json
{
  "input": "Mushoku Tensei III: Isekai Ittara Honki Dasu.mp4",
  "filename": "Mushoku Tensei III: Isekai Ittara Honki Dasu.mp4",
  "title": "Mushoku Tensei III: Isekai Ittara Honki Dasu",
  "extension": ".mp4",
  "isSequel": true,
  "status": "sequel-pattern-found",
  "seasonNumber": 3,
  "indicator": {
    "rule": "standalone_roman",
    "type": "standalone",
    "marker": null,
    "raw": "III",
    "value": "III",
    "number": 3,
    "notation": "roman",
    "confidence": 0.85
  },
  "matches": []
}
```

`matches` berisi seluruh temuan aktual; array pada contoh di atas disingkat untuk menjaga contoh tetap ringkas.

Untuk marker `Part`, `Arc`, atau `Cour`, `seasonNumber` bernilai `null`; nomor urutnya tersedia di `indicator.number` atau `matches[].number`. Untuk standalone suffix, nomor yang ditemukan juga diisikan ke `seasonNumber` sebagai nomor sequel yang terindikasi, bukan verifikasi database bahwa itu season formal.

## 9. Contoh perilaku yang diharapkan

| Input | `isSequel` | Alasan |
|---|---:|---|
| `Anime S2` | `true` | `S` langsung diikuti angka |
| `Anime S 2` | `false` | Spasi setelah `S` tidak diterima |
| `Anime Season IV` | `true` | Season + Romawi |
| `Anime II Season` | `false` | Bentuk terbalik Romawi ditolak |
| `Anime 3rd Season` | `true` | Ordinal angka sebelum Season |
| `Anime Twenty-first Season` | `true` | Ordinal Inggris sebelum Season |
| `Anime IV.mp4` | `true` | Romawi di akhir judul sebelum ekstensi |
| `Anime III: Subtitle` | `true` | Romawi tepat sebelum titik dua |
| `Anime 4.mkv` | `true` | Angka Arab di akhir judul sebelum ekstensi |
| `Anime Part 2` | `true` | Part + angka |
| `Anime Dai 2 Ki` | `false` | Penomoran Jepang tidak didukung |
| `Anime The Final` | `true` | Frasa The Final |
| `Anime Final` | `false` | Bare Final tidak diterima |
| `Anime IV [1080p].mkv` | `false` | Romawi bukan di akhir judul |

## 10. Batas penggunaan untuk `[NEW]`

Parser ini hanya menyediakan sinyal penamaan. Integrasi renamer sebaiknya tidak menyamakan `isSequel: false` dengan kepastian bahwa anime adalah judul pertama. Jika parser tidak menemukan pola, renamer dapat menerapkan kebijakan koleksi sendiri (misalnya memeriksa apakah judul sudah ada di database/folder tujuan) sebelum menambahkan `[NEW]`.
