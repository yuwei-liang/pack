import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createError, getHeader, getRequestURL } from 'h3';
import { findOrCreateUser, startSession } from '../../utils/authSession';
import { useAccountDb } from '../../utils/db';
import { readJsonBodyCapped, setPrivate } from '../../utils/http';
import { rateLimit } from '../../utils/rateLimit';

type Profile = { email: string; inviteHash?: string; salt?: string; hash?: string };
export default defineEventHandler(async event => {
  setPrivate(event);
  await rateLimit(event, 'auth-verify');
  const origin = getHeader(event, 'origin');
  if (origin && origin !== getRequestURL(event).origin) throw createError({statusCode:403});
  const body = await readJsonBodyCapped<{name?: string; password?: string; invite?: string}>(event, 2000);
  const name = String(body?.name ?? '').toLowerCase();
  const password = String(body?.password ?? '');
  if (password.length < 12 || password.length > 128) throw createError({statusCode:400,statusMessage:'Use 12–128 characters'});
  let profiles: Record<string, Profile>;
  try { profiles = JSON.parse(readFileSync('.household-auth.json', 'utf8')); }
  catch { throw createError({statusCode:503,statusMessage:'Household login is not configured'}); }
  const p = profiles[name];
  const fail = () => createError({statusCode:401,statusMessage:'Check your account, password or invitation'});
  if (!p) throw fail();
  if (!p.hash) {
    const inviteHash = createHash('sha256').update(String(body?.invite ?? '')).digest('hex');
    if (!p.inviteHash || !timingSafeEqual(Buffer.from(inviteHash,'hex'),Buffer.from(p.inviteHash,'hex'))) throw fail();
    p.salt = randomBytes(16).toString('hex');
    p.hash = scryptSync(password,p.salt,64).toString('hex');
    delete p.inviteHash;
    writeFileSync('.household-auth.json.tmp',JSON.stringify(profiles),{mode:0o600});
    renameSync('.household-auth.json.tmp','.household-auth.json');
  } else {
    if (!p.salt || !timingSafeEqual(scryptSync(password,p.salt,64),Buffer.from(p.hash,'hex'))) throw fail();
  }
  const db = await useAccountDb();
  const user = await findOrCreateUser(db,p.email);
  await startSession(event,db,user.id);
  return {ok:true};
});
