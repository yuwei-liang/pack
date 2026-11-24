import { eq } from "drizzle-orm";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { ACCESS_TOKENS_MAX, createAccessToken, listAccessTokens, resolveAccessToken } from "../server/utils/accessTokens";
import {
  appleAccount,
  appleAudiences,
  mintAppToken,
  revokeTokenByValue,
  verifyAppleIdentityToken,
  type AppleIdentity,
} from "../server/utils/appleSignIn";
import { createAccount, findOrCreateUser } from "../server/utils/authSession";
import { sha256Hex } from "../server/utils/tokens";
import { createTestDb, type TestDb } from "./helpers/db";

const AUD = "com.yuweiliang.home";
let privateKey: CryptoKey;
let keys: JWTVerifyGetKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  keys = createLocalJWKSet({ keys: [jwk] });
  otherKey = (await generateKeyPair("RS256")).privateKey;
});

async function token(claims: Record<string, unknown>, opts: { key?: CryptoKey; iss?: string; aud?: string; exp?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? "https://appleid.apple.com")
    .setAudience(opts.aud ?? AUD)
    .setSubject("001234.abcd")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "10m")
    .sign(opts.key ?? privateKey);
}

const verify = (t: unknown, nonce: unknown) => verifyAppleIdentityToken(t, nonce, { keys, audiences: [AUD] });

describe("verifyAppleIdentityToken", () => {
  it("accepts Apple's token for our app, bound to the nonce", async () => {
    const t = await token({ nonce: sha256Hex("raw-nonce"), email: "Molly@Example.com", email_verified: "true" });
    expect(await verify(t, "raw-nonce")).toEqual({ sub: "001234.abcd", email: "molly@example.com", nonceHash: sha256Hex("raw-nonce") });
  });

  it("refuses a wrong nonce, issuer, audience, signer or an expired token, all as null", async () => {
    const n = sha256Hex("n");
    expect(await verify(await token({ nonce: n }), "other")).toBeNull();
    expect(await verify(await token({}), "n")).toBeNull();
    expect(await verify(await token({ nonce: n }, { iss: "https://evil.example" }), "n")).toBeNull();
    expect(await verify(await token({ nonce: n }, { aud: "com.someone.else" }), "n")).toBeNull();
    expect(await verify(await token({ nonce: n }, { key: otherKey }), "n")).toBeNull();
    expect(await verify(await token({ nonce: n }, { exp: "-1m" }), "n")).toBeNull();
    expect(await verify("not.a.jwt", "n")).toBeNull();
    expect(await verify(undefined, "n")).toBeNull();
    expect(await verify(await token({ nonce: n }), undefined)).toBeNull();
  });

  it("keeps no email that is unverified or a private relay address", async () => {
    const n = sha256Hex("n");
    expect((await verify(await token({ nonce: n, email: "a@example.com", email_verified: false }), "n"))?.email).toBeNull();
    expect((await verify(await token({ nonce: n, email: "x@privaterelay.appleid.com", email_verified: true }), "n"))?.email).toBeNull();
    expect((await verify(await token({ nonce: n, email: "a@example.com", email_verified: true }), "n"))?.email).toBe("a@example.com");
  });

  it("reads the audience list from the env", () => {
    expect(appleAudiences(undefined)).toEqual([AUD]);
    expect(appleAudiences(" a.b , c.d ,")).toEqual(["a.b", "c.d"]);
  });
});

describe("appleAccount", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb(ACCOUNT_DDL);
  });
  const who = (over: Partial<AppleIdentity> = {}): AppleIdentity => ({ sub: "s1", email: "molly@example.com", nonceHash: "h", ...over });

  it("makes the account on first sign-in, links it, and finds it by sub after", async () => {
    const first = await appleAccount(db as any, who());
    expect(first).toMatchObject({ email: "molly@example.com" });
    const again = await appleAccount(db as any, who({ email: null }));
    expect(again).toEqual(first);
    const [row] = await db.select().from(schema.users);
    expect(row!.appleSub).toBe("s1");
  });

  it("links an existing account by its address", async () => {
    const existing = await findOrCreateUser(db as any, "molly@example.com");
    expect(await appleAccount(db as any, who())).toMatchObject({ id: existing.id });
  });

  it("is not_linked with no usable email, or when the account belongs to another Apple id", async () => {
    expect(await appleAccount(db as any, who({ email: null }))).toBe("not_linked");
    await appleAccount(db as any, who());
    expect(await appleAccount(db as any, who({ sub: "s2" }))).toBe("not_linked");
  });

  it("clears an unverified account's tokens and marks it verified", async () => {
    const u = await createAccount(db as any, "molly@example.com");
    await createAccessToken(db as any, u.id, { label: "squatter", scope: "write" });
    await appleAccount(db as any, who());
    expect(await listAccessTokens(db as any, u.id)).toHaveLength(0);
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(row!.emailVerified).toBe(true);
  });
});

describe("mintAppToken / revokeTokenByValue", () => {
  let db: TestDb;
  let userId: number;
  beforeEach(async () => {
    db = await createTestDb(ACCOUNT_DDL);
    userId = (await findOrCreateUser(db as any, "m@example.com")).id;
  });

  it("mints a write token under the label, replacing the same device's old one", async () => {
    const a = await mintAppToken(db as any, userId, "心安 · iPhone");
    const b = await mintAppToken(db as any, userId, "心安 · iPhone");
    expect(await resolveAccessToken(db as any, a!.token)).toBeNull();
    expect(await resolveAccessToken(db as any, b!.token)).toEqual({ userId, scope: "write" });
    const list = await listAccessTokens(db as any, userId);
    expect(list.map((t) => t.label)).toEqual(["心安 · iPhone"]);
    await mintAppToken(db as any, userId, undefined);
    expect((await listAccessTokens(db as any, userId)).map((t) => t.label)).toContain("心安");
  });

  it("is null when the account is full", async () => {
    for (let i = 0; i < ACCESS_TOKENS_MAX; i++) await createAccessToken(db as any, userId, { label: `t${i}`, scope: "read" });
    expect(await mintAppToken(db as any, userId, "心安 · iPhone")).toBeNull();
  });

  it("a token revokes itself, and only itself", async () => {
    const a = await mintAppToken(db as any, userId, "one");
    const b = await mintAppToken(db as any, userId, "two");
    expect(await revokeTokenByValue(db as any, a!.token)).toBe(true);
    expect(await revokeTokenByValue(db as any, a!.token)).toBe(false);
    expect(await resolveAccessToken(db as any, b!.token)).not.toBeNull();
  });
});
