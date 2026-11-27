let handler = async (m, { text }) => {
  const match = /^([^\n.]{1,60})\.(\d{1,3})$/.exec(text)
  if (!match || +match[2] < 1 || +match[2] > 120) throw 'Gunakan .register Nama.20 (umur 1–120).'
  const user = global.db.ensure('users', m.sender)
  if (user.registered) throw 'Lo sudah terdaftar.'
  user.name = match[1].trim(); user.age = +match[2]; user.registered = true; user.regTime = Date.now()
  await global.db.save('users'); await m.reply('Pendaftaran berhasil.')
}
handler.help = ['register Nama.umur'];
handler.tags = ['main'];
handler.command = /^(register|daftar)$/i;
handler.register = false;
// Dibagikan ke sub-bot: gerbang registrasi berlaku di sana, tapi perintahnya
// belum ada (temuan Veo 2026-11-27) — user sub-bot tidak bisa daftar sama
// sekali. Registrasi sub-bot tercatat di DB sandbox-nya sendiri.
handler.sharing = true;
export default handler
