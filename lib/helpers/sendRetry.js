// lib/helpers/sendRetry.js
//
// Utilitas bersama pengiriman file ke WA untuk permukaan downloader
// (lib/downloader/runJob.js dan plugins/downloader/unduh.js): kenali
// kegagalan kirim kelas KONEKSI dan tunggu koneksi pulih, supaya
// pengirim bisa mengulang pengiriman SEKALI dari file yang sama di
// disk tanpa mengunduh ulang.
//
// Latar (insiden 2026-11-06): unggahan .dl sebesar 978 MB mati di
// tengah jalan karena koneksi utama backoff ±6 detik; unduhannya
// sendiri selesai utuh. Error non-koneksi (file ditolak WA, format
// rusak, batas ukuran) TIDAK diulang — mengulang tidak mengubah hasil.

// Batas tunggu koneksi pulih sebelum pengiriman dinyatakan gagal.
export const SEND_RETRY_WAIT_MS = 120_000

const CONNECTION_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'ENOTFOUND', 'EAI_AGAIN', 'ERR_STREAM_PREMATURE_CLOSE',
])

// True bila error kegagalan kirim tampak disebabkan koneksi yang
// putus/tertutup — bukan oleh file atau keputusan server soal konten.
export function isConnectionSendError(e) {
  if (!e) return false
  const status = e?.output?.statusCode ?? e?.statusCode ?? e?.status
  if (status === 408 || status === 428) return true // timeout / connection closed (Boom Baileys)
  if (CONNECTION_CODES.has(String(e?.code ?? ''))) return true
  const text = `${e?.name ?? ''} ${e?.message ?? e}`
  return /koneksi belum terbuka|connection (was )?(closed|lost|terminated)|connection error|stream (closed|error)|socket hang up|fetch failed|restart required|timed?\s?out|timeout/i.test(text)
}

// Tunggu sampai koneksi WA terbuka lagi, maksimal timeoutMs.
// Sinyal utama: event 'connection.update' di conn.ev (pola yang sama
// seperti lib/connection/controller.js), dicadangkan polling
// conn.ws.readyState untuk event yang terlewat. Mengembalikan false
// bila batas waktu habis. Bila conn tidak punya sumber event sama
// sekali, beri jeda singkat lalu true — percobaan kirim berikutnya
// yang membuktikan (penjaga canSend di lib/simple.js gagal-cepat
// dengan 'Koneksi belum terbuka' bila memang masih tertutup).
export async function waitForConnectionOpen(conn, timeoutMs = SEND_RETRY_WAIT_MS) {
  if (!conn) return false
  const wsOpen = () => { try { return conn.ws?.readyState === 1 } catch { return false } }
  if (wsOpen()) return true
  const ev = conn.ev
  if (!ev?.on) {
    await new Promise(r => setTimeout(r, Math.min(timeoutMs, 3_000)))
    return true
  }
  return new Promise(resolve => {
    let settled = false
    const finish = ok => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(poll)
      try { ev.off?.('connection.update', onUpdate) } catch { /* abaikan */ }
      resolve(ok)
    }
    const onUpdate = update => { if (update?.connection === 'open' || wsOpen()) finish(true) }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const poll = setInterval(() => { if (wsOpen()) finish(true) }, 2_000)
    ev.on('connection.update', onUpdate)
  })
}
