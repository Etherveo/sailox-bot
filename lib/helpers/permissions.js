export function permissionFailure(p, { m, userData: u, chat, isFounder, isOwner, isMods, isPrems, isAdmin, isBotAdmin }) {
  for (const [flag, ok, fail] of [['founder', isFounder, 'founder'], ['owner', isOwner, 'owner'], ['maintenance', isOwner, 'maintenance'], ['mods', isMods, 'mods'], ['premium', isPrems, 'premium'], ['group', m.isGroup, 'group'], ['botAdmin', m.isGroup, 'group'], ['botAdmin', isBotAdmin, 'botAdmin'], ['admin', m.isGroup, 'group'], ['admin', isAdmin, 'admin'], ['private', !m.isGroup, 'private'], ['game', !m.isGroup || chat.game, 'game'], ['nsfw', !m.isGroup || chat.nsfw, 'nsfw'], ['rpg', m.isGroup && chat.rpg && u.registered, 'rpg']]) if (p[flag] && !ok) return fail
  // Registrasi adalah gerbang bawaan (keputusan Veo 2026-11-05): SEMUA
  // plugin hanya untuk user terdaftar, tanpa plugin perlu menandai
  // register = true satu per satu. Satu-satunya jalan keluar adalah
  // register = false secara eksplisit (mis. perintah register itu
  // sendiri, supaya orang bisa mendaftar). Owner selalu lolos.
  if (p.register !== false && !isOwner && !u.registered) return 'unreg'
  if (p.level && u.level < p.level) return 'level'
  if (p.limit && !isPrems && u.limit < Number(p.limit)) return 'limit'
  return null
}
