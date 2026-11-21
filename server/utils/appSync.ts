// The owner's native app (心安, offline-first): the two narrow doors an access token
// opens onto the account's CLAIMED lists, which the MCP tools still cannot reach.
//
// An access token was built for an assistant and deliberately stops at My Gear
// (accessTokens.ts). The phone app is the same person as the session that claimed
// the lists, holding the same token they minted on /account, so it gets exactly two
// things on top: one read of everything it needs to work offline
// (/api/app/sync), and one write, packing ticks (/api/app/packed). Nothing else a
// claim allows — renames, deletes, publishing, rotating — is reachable this way.

import type { H3Event } from "h3";
import { createError } from "h3";
import type { Op } from "../../shared/ops";
import { accessTokenFrom, resolveAccessToken, type AccessScope } from "./accessTokens";
import { useAccountDb, type Db } from "./db";
import { setNoIndex, setPrivate } from "./http";
import { rateLimit, rateLimitSubject, type RateLimitAction } from "./rateLimit";

/**
 * The token's account, or a throw: 401 for no token or one that opens nothing (never
 * issued, or revoked), 403 for a read token at the write door.
 *
 * Headers and the per-address budget come FIRST, so a refusal is private and a flood
 * of made-up bearers is throttled before it costs a lookup each; then the same budget
 * again per account, so one phone on a shared address never spends another's.
 */
export async function requireAppAccess(
  event: H3Event,
  need: AccessScope,
  action: RateLimitAction,
): Promise<{ db: Db; userId: number }> {
  setNoIndex(event);
  setPrivate(event);
  await rateLimit(event, action);
  const raw = accessTokenFrom(event);
  if (!raw) throw createError({ statusCode: 401, statusMessage: "Missing access token" });
  const db = await useAccountDb();
  const access = await resolveAccessToken(db, raw);
  if (!access) throw createError({ statusCode: 401, statusMessage: "Access token not recognised" });
  if (need === "write" && access.scope !== "write")
    throw createError({ statusCode: 403, statusMessage: "This access token can only read" });
  await rateLimitSubject(action, `app:${access.userId}`);
  return { db, userId: access.userId };
}

export interface AppTick {
  itemId: string;
  bagId?: string;
  packed: boolean;
}

export const APP_TICKS_MAX = 500;
const ID_MAX = 200;

/**
 * The body's ticks, validated whole, or null when any one is malformed or the count
 * is outside 1..APP_TICKS_MAX. All-or-nothing on purpose: an offline queue that
 * half-lands would leave the app unsure which of its ticks the server holds.
 */
export function parseAppTicks(raw: unknown): AppTick[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > APP_TICKS_MAX) return null;
  const out: AppTick[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") return null;
    const { itemId, bagId, packed } = t as Record<string, unknown>;
    if (typeof itemId !== "string" || !itemId || itemId.length > ID_MAX) return null;
    if (typeof packed !== "boolean") return null;
    if (bagId != null && (typeof bagId !== "string" || !bagId || bagId.length > ID_MAX)) return null;
    out.push(typeof bagId === "string" ? { itemId, bagId, packed } : { itemId, packed });
  }
  return out;
}

/** A tick as the editor's own op: a bag's share ticks that share (and the row follows
 *  its shares), a bare tick ticks the row (and every share follows it). */
export function appTicksToOps(ticks: readonly AppTick[]): Op[] {
  return ticks.map((t): Op =>
    t.bagId
      ? { t: "packPlacement", id: t.itemId, bagId: t.bagId, packed: t.packed }
      : { t: "updateItem", id: t.itemId, patch: { packed: t.packed } },
  );
}
