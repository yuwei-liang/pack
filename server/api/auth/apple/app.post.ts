import { defineEventHandler, setResponseStatus } from "h3";
import { appleAccount, appleAudiences, appleKeys, APPLE_NONCE_TTL_S, mintAppToken, verifyAppleIdentityToken } from "../../../utils/appleSignIn";
import { useAccountDb } from "../../../utils/db";
import { readJsonBodyCapped, setNoIndex } from "../../../utils/http";
import { rateLimit, useKv } from "../../../utils/rateLimit";

// Sign in with Apple from the app (心安): Apple identity token in, Pack write token out.
// See server/utils/appleSignIn.ts.
//
// 400 invalid: every verification failure, one answer (bad signature, wrong issuer or
//     audience, expired, nonce mismatch, a nonce already spent).
// 409 not_linked: a good token, but no account it can be matched to safely.
// 409 tokens_full: the account holds the most access tokens it may.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await rateLimit(event, "auth-apple");

  const body = await readJsonBodyCapped<{ identityToken?: unknown; nonce?: unknown; label?: unknown }>(event, 12_000);
  const who = await verifyAppleIdentityToken(body?.identityToken, body?.nonce, {
    keys: appleKeys(),
    audiences: appleAudiences(),
  });
  // a nonce signs in once: a token lifted off the wire can't be posted again
  const kv = useKv();
  const spentKey = who ? `apple-nonce:${who.nonceHash}` : "";
  if (!who || (await kv.getItem(spentKey))) {
    setResponseStatus(event, 400);
    return { ok: false as const, reason: "invalid" as const };
  }
  await kv.setItem(spentKey, 1, { ttl: APPLE_NONCE_TTL_S });

  const db = await useAccountDb();
  const user = await appleAccount(db, who);
  if (user === "not_linked") {
    setResponseStatus(event, 409);
    return { ok: false as const, reason: "not_linked" as const };
  }
  const made = await mintAppToken(db, user.id, body?.label);
  if (!made) {
    setResponseStatus(event, 409);
    return { ok: false as const, reason: "tokens_full" as const };
  }
  return {
    ok: true as const,
    token: made.token,
    scope: "write" as const,
    tokenId: made.id,
    user: { email: user.email, ...(user.displayName ? { displayName: user.displayName } : {}) },
  };
});
