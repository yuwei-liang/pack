import { createError, defineEventHandler } from "h3";
import { parseAppOps, requireAppAccess } from "../../utils/appSync";
import { appListAccess, opsForRole } from "../../utils/listMembers";
import { notFound, readJsonBodyCapped } from "../../utils/http";
import { applyOpsByEditHash } from "../../utils/listRepo";

// POST /api/app/ops — the general write door: an access token acting as its owner on
// a list the account has CLAIMED, with any op the editor itself sends (shared/ops.ts).
// Write-scope token only (a read token is a 403). See appSync.ts for the model.
//
//   body:  { shareCode, ops: Op[] }   1..500 ops, each { t: <known op type>, ... }
//   reply: { version }   the list's version after the batch landed
//
// The ops go through applyOpsByEditHash with the list row's edit hash, exactly as a
// web edit's do (mutate.post.ts): versions, merge-on-conflict, recovery snapshots,
// change summaries and setPlan normalisation all behave the same. An op naming a row
// the list doesn't hold is skipped by the reducer, as it is for the editor. An unknown
// op type, a non-object op or a batch outside 1..500 fails the whole batch with a 400
// (never sliced). A list this account hasn't claimed, or one deleted, is the same 404
// as a code that never existed.
//
// Lifecycle actions — delete, publish, rotate the edit link, restore a snapshot,
// claim — are not ops and are not reachable here.
export default defineEventHandler(async (event) => {
  const { db, userId } = await requireAppAccess(event, "write", "app-ops");
  // the editor's own body cap (mutate.post.ts); 500 ops sit well inside it
  const body = await readJsonBodyCapped<{ shareCode?: unknown; ops?: unknown }>(event, 512_000);
  const shareCode = typeof body?.shareCode === "string" ? body.shareCode : "";
  if (!shareCode) throw createError({ statusCode: 400, statusMessage: "shareCode required" });
  const ops = parseAppOps(body?.ops);
  if (typeof ops === "string") throw createError({ statusCode: 400, statusMessage: ops });
  // the owner's claim or a membership the owner gave (listMembers.ts)
  const access = await appListAccess(db, userId, shareCode);
  if (!access) throw notFound();
  const { hash } = access;
  const snapshot = await applyOpsByEditHash(hash, await opsForRole(access.role, hash, ops), db);
  if (!snapshot) throw notFound();
  return { version: snapshot.version };
});
