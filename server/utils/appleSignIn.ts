// Sign in with Apple, for the app (心安) only. The web keeps its magic link and passkeys.
//
// The app runs Apple's native sign-in and posts us the identity token it got back. We
// check it is Apple's, for our app, fresh, and bound to the nonce the app made; then
// find the account (by Apple's `sub`, or once by a verified, non-relay email) and mint
// an ordinary write access token. It is listed on /account under its label and goes
// with "sign out everywhere", like any other token.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { and, eq } from "drizzle-orm";
import { accessTokens, users } from "../db/schema";
import type { Db } from "./db";
import { claimUnverifiedAccount, findOrCreateUser, normalizeEmail } from "./authSession";
import { createAccessToken } from "./accessTokens";
import { sha256Hex } from "./tokens";

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const DEFAULT_AUDIENCES = ["com.yuweiliang.home"];
/** Apple's identity tokens live 10 minutes; a nonce is spent for that long. */
export const APPLE_NONCE_TTL_S = 600;
export const APPLE_DEFAULT_LABEL = "心安";

/** The bundle ids we accept tokens for: APPLE_APP_AUDIENCES (comma list) or the default. */
export function appleAudiences(env: string | undefined = process.env.APPLE_APP_AUDIENCES): string[] {
  const list = (env ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_AUDIENCES;
}

let remoteKeys: JWTVerifyGetKey | null = null;
/** Apple's signing keys, fetched and cached by jose (it refetches on an unknown kid). */
export function appleKeys(): JWTVerifyGetKey {
  remoteKeys ??= createRemoteJWKSet(new URL(APPLE_JWKS_URL));
  return remoteKeys;
}

export interface AppleIdentity {
  sub: string;
  /** Only an address Apple says is verified and that isn't a private relay one. */
  email: string | null;
  /** sha256hex of the raw nonce: the key a replay check spends. */
  nonceHash: string;
}

/**
 * The identity in a token, or null for anything that isn't a fresh Apple token for one
 * of `audiences`, bound to `rawNonce`. Every failure is the same null.
 */
export async function verifyAppleIdentityToken(
  identityToken: unknown,
  rawNonce: unknown,
  opts: { keys: JWTVerifyGetKey; audiences: string[] },
): Promise<AppleIdentity | null> {
  if (typeof identityToken !== "string" || !identityToken || identityToken.length > 8_000) return null;
  if (typeof rawNonce !== "string" || !rawNonce || rawNonce.length > 200) return null;
  let payload;
  try {
    ({ payload } = await jwtVerify(identityToken, opts.keys, {
      issuer: APPLE_ISSUER,
      audience: opts.audiences,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat"],
    }));
  } catch {
    return null;
  }
  const nonceHash = sha256Hex(rawNonce);
  if (typeof payload.nonce !== "string" || payload.nonce.toLowerCase() !== nonceHash) return null;
  const sub = payload.sub;
  if (typeof sub !== "string" || !sub || sub.length > 255) return null;
  // Apple sends email_verified as a boolean or as the string "true"
  const verified = payload.email_verified === true || payload.email_verified === "true";
  const email = verified ? normalizeEmail(payload.email) : null;
  const relay = email?.endsWith("@privaterelay.appleid.com") ?? false;
  return { sub, email: email && !relay ? email : null, nonceHash };
}

export type AppleAccount = { id: number; email: string; displayName: string | null };

/**
 * The account an Apple identity signs into, or "not_linked".
 *
 * By `sub` once linked. Before that, by the verified address: the account for it
 * (made now if there's none, as a first magic link would), which is then linked. An
 * account already linked to a DIFFERENT Apple id isn't taken over by a second one
 * claiming the same address.
 */
export async function appleAccount(db: Db, who: AppleIdentity): Promise<AppleAccount | "not_linked"> {
  const pick = { id: users.id, email: users.email, displayName: users.displayName, emailVerified: users.emailVerified, appleSub: users.appleSub };
  const [linked] = await db.select(pick).from(users).where(eq(users.appleSub, who.sub)).limit(1);
  if (linked) return { id: linked.id, email: linked.email, displayName: linked.displayName };
  if (!who.email) return "not_linked";

  const made = await findOrCreateUser(db, who.email);
  const [row] = await db.select(pick).from(users).where(eq(users.id, made.id)).limit(1);
  if (!row || (row.appleSub && row.appleSub !== who.sub)) return "not_linked";

  // Apple has just proved this address. An account nobody had proved it for yet loses
  // what was attached on the strength of the claim alone (verify.post.ts does the
  // same): passkeys, sessions and access tokens.
  if (!row.emailVerified) await claimUnverifiedAccount(db, row.id);
  await db.update(users).set({ appleSub: who.sub }).where(eq(users.id, row.id));
  return { id: row.id, email: row.email, displayName: row.displayName };
}

/**
 * A write token for the app, labelled. A token already on the account under the same
 * label is that same device signing in again, and is replaced rather than piling up.
 * Null when the account still holds the maximum.
 */
export async function mintAppToken(db: Db, userId: number, rawLabel: unknown): Promise<{ id: number; token: string } | null> {
  const label = (typeof rawLabel === "string" ? rawLabel.trim().slice(0, 60) : "") || APPLE_DEFAULT_LABEL;
  await db.delete(accessTokens).where(and(eq(accessTokens.userId, userId), eq(accessTokens.label, label)));
  return createAccessToken(db, userId, { label, scope: "write" });
}

/** The bearer token revokes itself. True when a row went (false: already gone). */
export async function revokeTokenByValue(db: Db, raw: string): Promise<boolean> {
  const gone = await db.delete(accessTokens).where(eq(accessTokens.tokenHash, sha256Hex(raw))).returning();
  return gone.length > 0;
}
