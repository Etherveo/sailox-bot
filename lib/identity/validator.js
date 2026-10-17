import { jidNormalizedUser, areJidsSameUser, isLidUser, isPnUser } from '@whiskeysockets/baileys'
export function checkRecord(user, users = {}) {
  if (!user || !isLidUser(user.lid) || !isPnUser(user.jid)) return { ok: false, reason: 'Record identitas tidak lengkap' }
  const jid = jidNormalizedUser(user.jid), lid = jidNormalizedUser(user.lid)
  for (const r of Object.values(users)) if (r !== user && r.jid && r.lid && areJidsSameUser(jidNormalizedUser(r.jid), jid) && !areJidsSameUser(jidNormalizedUser(r.lid), lid)) return { ok: false, reason: 'Nomor terhubung ke dua LID' }
  return { ok: true, lid, jid }
}
export function validateTarget(input, { db, same } = {}) {
  for (const [key, user] of Object.entries(db?.data.users ?? {})) if (same(input, key) || same(input, user.jid)) return checkRecord({ ...user, lid: user.lid || key }, db.data.users)
  return { ok: false, lid: null, jid: null, reason: 'Pemetaan belum diketahui' }
}
