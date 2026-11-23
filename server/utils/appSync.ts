// The owner's native app (心安, offline-first) and the owner's assistant: an access
// token acts as its OWNER on the lists that account has CLAIMED (and that are live).
//
// Two capabilities, two jobs. An edit link (/e/CODE#token) is the SHARING capability:
// whoever holds it can change that list, which is how editing is handed to someone
// else, and it keeps working exactly as before. An access token is the ACCOUNT: on a
// claimed list it can do everything the editor's op stream can — POST /api/app/ops is
// the general door, /api/app/packed and /api/app/rows the narrow ones the installed
// app already speaks, GET /api/app/sync the read — and over MCP the list tools take a
// share code in place of an edit link (mcp.ts, listHashFor). Write scope for writes.
//
// Lifecycle actions stay with a session or the edit link and are NOT reachable with a
// token: deleting a list, publishing or unpublishing it, rotating its edit link,
// restoring a snapshot, claiming and unclaiming.

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

export const APP_OPS_MAX = 500;

/**
 * Every op type the reducer knows (shared/ops.ts), as a record so the compiler fails
 * here when a type is added there and not here. Kept server-side so the editor's
 * bundle doesn't carry it.
 */
const KNOWN_OP_TYPES: Record<Op["t"], true> = {
  addItem: true,
  updateItem: true,
  removeItem: true,
  moveItem: true,
  addFolder: true,
  updateFolder: true,
  removeFolder: true,
  addDay: true,
  updateDay: true,
  removeDay: true,
  addWaypoint: true,
  updateWaypoint: true,
  removeWaypoint: true,
  addPerson: true,
  updatePerson: true,
  removePerson: true,
  addBag: true,
  updateBag: true,
  removeBag: true,
  setPlacements: true,
  packPlacement: true,
  setPlan: true,
  checkPlanStep: true,
  setMeta: true,
};

export const isKnownOpType = (t: unknown): t is Op["t"] =>
  typeof t === "string" && Object.prototype.hasOwnProperty.call(KNOWN_OP_TYPES, t);

/**
 * The body's ops, or the sentence saying why not: 1..APP_OPS_MAX, each an object
 * whose `t` the reducer knows. Past that the ops are the editor's and go to the
 * reducer as the editor's do (mutate.post.ts) — it ignores what it can't apply and
 * normalises what it can — so this is a shape gate, not a second reducer.
 */
export function parseAppOps(raw: unknown): Op[] | string {
  if (!Array.isArray(raw) || raw.length < 1) return "ops must be a non-empty array";
  // loud, never sliced: a truncated batch would quietly drop the queue's tail
  if (raw.length > APP_OPS_MAX) return `Too many ops: at most ${APP_OPS_MAX} per request`;
  for (const [i, op] of raw.entries()) {
    if (!op || typeof op !== "object" || Array.isArray(op)) return `ops[${i}] must be an object`;
    if (!isKnownOpType((op as { t?: unknown }).t)) return `ops[${i}]: unknown op type`;
  }
  return raw as Op[];
}
