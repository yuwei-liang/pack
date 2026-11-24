import { defineEventHandler, setResponseStatus } from "h3";
import { accessTokenFrom } from "../../../utils/accessTokens";
import { revokeTokenByValue } from "../../../utils/appleSignIn";
import { useAccountDb } from "../../../utils/db";
import { rateLimit } from "../../../utils/rateLimit";

// An access token revokes itself: the app's sign-out. 204 whether or not it was still
// live, so a retry after a lost response is safe; 401 without a token at all.
export default defineEventHandler(async (event) => {
  await rateLimit(event, "account");
  const raw = accessTokenFrom(event);
  if (!raw) {
    setResponseStatus(event, 401);
    return { ok: false as const, reason: "no_token" as const };
  }
  await revokeTokenByValue(await useAccountDb(), raw);
  setResponseStatus(event, 204);
  return null;
});
