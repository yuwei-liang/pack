import { createError, defineEventHandler } from "h3";
import { requireAppAccess } from "../../utils/appSync";
import { claimedEditHash } from "../../utils/claimRepo";
import { notFound, readJsonBodyCapped } from "../../utils/http";
import { applyOpsByEditHash } from "../../utils/listRepo";
import type { Op } from "../../../shared/ops";
import type { Item } from "../../../shared/types";

// POST /api/app/rows — the owner's app drops a row from a trip ("not bringing it")
// and puts one back ("bringing it after all"). Write-scope token only, a claimed live
// list only — the same door rules as /api/app/packed (appSync.ts).
//
//   body:  { shareCode, remove?: [itemId], restore?: [Item] }   1..100 entries in all
//   reply: { version }
//
// Both are the editor's own ops: `removeItem` (a parent takes its nested rows with
// it, as in the editor) and `addItem` with the row exactly as the app last synced it,
// so a put-back row keeps its id, weight, bags and notes. The reducer normalises an
// added row (normalizeItem) and coerces a folder or parent that no longer exists, so a
// restore after someone reshaped the list on the web still lands sensibly; a row
// whose id is already on the list is not added twice (canAdd). Every applied batch is
// a normal edit: version bump and recovery snapshot, so a wrong drop is also
// recoverable from the web's history.
export const APP_ROWS_MAX = 100;

export default defineEventHandler(async (event) => {
  const { db, userId } = await requireAppAccess(event, "write", "app-packed");
  const body = await readJsonBodyCapped<{ shareCode?: unknown; remove?: unknown; restore?: unknown }>(event, 256_000);
  const shareCode = typeof body?.shareCode === "string" ? body.shareCode : "";
  if (!shareCode) throw createError({ statusCode: 400, statusMessage: "shareCode required" });
  const remove = body?.remove ?? [];
  const restore = body?.restore ?? [];
  const bad = () => createError({ statusCode: 400, statusMessage: "remove: [itemId], restore: [item], 1-100 in all" });
  if (!Array.isArray(remove) || !Array.isArray(restore)) throw bad();
  const total = remove.length + restore.length;
  if (total < 1 || total > APP_ROWS_MAX) throw bad();
  const ops: Op[] = [];
  for (const id of remove) {
    if (typeof id !== "string" || !id || id.length > 200) throw bad();
    ops.push({ t: "removeItem", id });
  }
  for (const it of restore) {
    if (!it || typeof it !== "object" || Array.isArray(it)) throw bad();
    const { id, name } = it as Record<string, unknown>;
    if (typeof id !== "string" || !id || id.length > 200 || typeof name !== "string") throw bad();
    ops.push({ t: "addItem", item: it as Item });
  }
  const hash = await claimedEditHash(db, userId, shareCode);
  if (!hash) throw notFound();
  const snapshot = await applyOpsByEditHash(hash, ops, db);
  if (!snapshot) throw notFound();
  return { version: snapshot.version };
});
