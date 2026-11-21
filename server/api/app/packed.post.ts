import { createError, defineEventHandler } from "h3";
import { appTicksToOps, parseAppTicks, requireAppAccess } from "../../utils/appSync";
import { claimedEditHash } from "../../utils/claimRepo";
import { notFound, readJsonBodyCapped } from "../../utils/http";
import { applyOpsByEditHash } from "../../utils/listRepo";

// POST /api/app/packed — the owner's native app writes its packing ticks back.
// Write-scope access token only (a read token is a 403).
//
//   body:  { shareCode, ticks: [ { itemId, bagId?, packed } ] }   1..500 ticks
//   reply: { version }   the list's version after the ticks landed
//
// A tick with a bagId ticks that bag's share of the row ({t:"packPlacement"}), and
// the row's own `packed` follows its shares; one without ticks the row
// ({t:"updateItem", patch:{packed}}), and every share follows it. These are the
// editor's own ops, applied through applyOpsByEditHash with the list row's edit hash,
// so versioning, recovery snapshots and cached totals are exactly a normal edit's.
//
// The list must be one this account has CLAIMED and still live, or it is the same
// 404 as a code that never existed. An itemId (or bagId) the list doesn't hold is
// skipped by the reducer, as it is for the editor — a tick for a row deleted on the
// web while the phone was offline simply doesn't land; the batch still applies and
// the version still moves. A malformed tick fails the whole batch with a 400.
export default defineEventHandler(async (event) => {
  const { db, userId } = await requireAppAccess(event, "write", "app-packed");
  // 500 ticks at ~100 B each, with room to spare
  const body = await readJsonBodyCapped<{ shareCode?: unknown; ticks?: unknown }>(event, 128_000);
  const shareCode = typeof body?.shareCode === "string" ? body.shareCode : "";
  if (!shareCode) throw createError({ statusCode: 400, statusMessage: "shareCode required" });
  const ticks = parseAppTicks(body?.ticks);
  if (!ticks) throw createError({ statusCode: 400, statusMessage: "ticks must be 1-500 { itemId, bagId?, packed }" });
  const hash = await claimedEditHash(db, userId, shareCode);
  if (!hash) throw notFound();
  const snapshot = await applyOpsByEditHash(hash, appTicksToOps(ticks), db);
  if (!snapshot) throw notFound();
  return { version: snapshot.version };
});
