import { TTLCache } from './cache.js'
const notices = new TTLCache({ max: 5000, ttl: 10000 })
export const messages = {
  founder: 'Perintah ini khusus founder.', owner: 'Perintah ini khusus owner.', mods: 'Perintah ini khusus moderator.', premium: 'Perintah ini khusus premium.', group: 'Gunakan perintah ini di grup.', private: 'Gunakan perintah ini lewat chat pribadi.', admin: 'Perintah ini khusus admin grup.', botAdmin: 'Bot harus menjadi admin grup.', unreg: 'Daftar dulu dengan .register Nama.20', rpg: 'RPG memerlukan grup aktif dan akun terdaftar.', game: 'Fitur game belum aktif di grup ini.', nsfw: 'Fitur NSFW belum aktif di grup ini.', maintenance: 'Perintah sedang diperbaiki.', limit: 'Limit lo tidak cukup.', level: 'Level lo belum memenuhi syarat.', cooldown: 'Tunggu sebentar sebelum mengirim perintah lagi.', internal: 'Terjadi kesalahan. Coba lagi nanti.',
  welcome: 'Selamat datang @user di @subject!', bye: 'Sampai jumpa @user.', promote: '@user sekarang menjadi admin.', demote: '@user tidak lagi menjadi admin.', subject: 'Nama grup berubah: @subject', desc: 'Deskripsi grup berubah: @desc', icon: 'Ikon grup diperbarui.', revoke: 'Tautan undangan grup diperbarui.', announce: 'Pengaturan kirim pesan grup diperbarui.', restrict: 'Pengaturan edit info grup diperbarui.',
}
export async function dfail(type, m, conn = m.conn) {
  if (type === 'cooldown') { if (notices.get(m.sender)) return; notices.set(m.sender, true) }
  return conn.reply(m.chat, messages[type] ?? messages.internal, m)
}
