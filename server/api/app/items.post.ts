import { createError, defineEventHandler } from "h3";
import { requireAppAccess } from "../../utils/appSync";
import { claimedEditHash } from "../../utils/claimRepo";
import { notFound, readJsonBodyCapped } from "../../utils/http";
import { applyOpsByEditHash, getByEditHash } from "../../utils/listRepo";
import type { Op } from "../../../shared/ops";
import type { Item } from "../../../shared/types";
import { nextSortOrder } from "../../../shared/weights";

// POST /api/app/items — the owner's app adds rows to a trip and changes them: how
// many, which folder, which bag. Write-scope token only, a claimed live list only —
// the same door rules as /api/app/rows and /api/app/packed (appSync.ts). Removing a
// row stays on /api/app/rows.
//
//   body:  { shareCode,
//            add?:    [{ id, name, qty?, folderId?, bagId? }],
//            update?: [{ id, qty?, folderId?, bagId? }] }        1..100 entries in all
//   reply: { version }
//
// Every entry becomes the editor's own ops, so a batch from the app is a web edit in
// every respect: version bump, recovery snapshot, totals, the change history.
//
// ADD — `id` is the app's (client ids, like the editor's), so a retried batch is a
// no-op: the reducer's addItem skips an id the list already has. `qty` defaults to 1.
// A `folderId` the list doesn't have files the row under Unfiled (folderId null), the
// reducer's own coercion. `bagId` puts the whole qty in that bag.
//
// UPDATE — an id the list doesn't have is skipped. `qty` sets the row's quantity; a
// row sitting WHOLE in one bag keeps sitting whole in it (its share grows or shrinks
// with it), and a split row has its shares trimmed from the last bag back when the
// qty drops below them, the editor's rule. `folderId` moves the row (null = Unfiled;
// an unknown id is skipped rather than unfiling the row; a nested row stays with its
// parent). `bagId` moves the whole qty into that bag, and null takes it out of every
// bag; an unknown bag id is skipped.
//
// Adds apply before updates, so one batch can add a row and then change it.
export const APP_ITEMS_MAX = 100;
export const APP_ITEM_QTY_MAX = 999;
const ID_MAX = 200;
const NAME_MAX = 200;

type Add = { id: string; name: string; qty: number; folderId?: string | null; bagId?: string | null };
type Update = { id: string; qty?: number; folderId?: string | null; bagId?: string | null };

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= ID_MAX;
const isQty = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= APP_ITEM_QTY_MAX;
/** absent, null, or an id — anything else is malformed */
const isRef = (v: unknown) => v === undefined || v === null || isId(v);

/** One entry, checked; null when it's malformed (which fails the whole batch). */
function parseAdd(raw: unknown): Add | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!isId(r.id) || !name || name.length > NAME_MAX) return null;
  if (r.qty !== undefined && !isQty(r.qty)) return null;
  if (!isRef(r.folderId) || !isRef(r.bagId)) return null;
  return { id: r.id, name, qty: (r.qty as number | undefined) ?? 1, folderId: r.folderId as string | null | undefined, bagId: r.bagId as string | null | undefined };
}
function parseUpdate(raw: unknown): Update | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isId(r.id)) return null;
  if (r.qty !== undefined && !isQty(r.qty)) return null;
  if (!isRef(r.folderId) || !isRef(r.bagId)) return null;
  const u: Update = { id: r.id };
  if (r.qty !== undefined) u.qty = r.qty as number;
  if ("folderId" in r) u.folderId = r.folderId as string | null;
  if ("bagId" in r) u.bagId = r.bagId as string | null;
  return u;
}

export default defineEventHandler(async (event) => {
  const { db, userId } = await requireAppAccess(event, "write", "app-packed");
  const body = await readJsonBodyCapped<{ shareCode?: unknown; add?: unknown; update?: unknown }>(event, 256_000);
  const shareCode = typeof body?.shareCode === "string" ? body.shareCode : "";
  if (!shareCode) throw createError({ statusCode: 400, statusMessage: "shareCode required" });
  const rawAdd = body?.add ?? [];
  const rawUpdate = body?.update ?? [];
  const bad = () =>
    createError({ statusCode: 400, statusMessage: `add: [{id, name, qty?, folderId?, bagId?}], update: [{id, qty?, folderId?, bagId?}], 1-${APP_ITEMS_MAX} in all` });
  if (!Array.isArray(rawAdd) || !Array.isArray(rawUpdate)) throw bad();
  const total = rawAdd.length + rawUpdate.length;
  if (total < 1 || total > APP_ITEMS_MAX) throw bad();
  const adds = rawAdd.map(parseAdd);
  const updates = rawUpdate.map(parseUpdate);
  if (adds.some((a) => !a) || updates.some((u) => !u)) throw bad();

  const hash = await claimedEditHash(db, userId, shareCode);
  if (!hash) throw notFound();
  const list = await getByEditHash(hash, db);
  if (!list) throw notFound();

  const folders = new Set(list.folders.map((f) => f.id));
  const bags = new Set((list.bags ?? []).map((b) => b.id));
  // the rows as they will stand, so sort orders and "whole in one bag" read the batch
  const working: Item[] = list.items.map((i) => ({ ...i }));
  const ops: Op[] = [];

  for (const a of adds as Add[]) {
    if (working.some((i) => i.id === a.id)) continue; // a retry: the row is already there
    const folderId = a.folderId && folders.has(a.folderId) ? a.folderId : null;
    const item: Item = {
      id: a.id,
      folderId,
      name: a.name,
      unitWeightMg: 0,
      qty: a.qty,
      classification: null,
      sortOrder: nextSortOrder(working, folderId),
      ...(a.bagId && bags.has(a.bagId) ? { placements: [{ bagId: a.bagId, qty: a.qty }] } : {}),
    };
    ops.push({ t: "addItem", item });
    working.push(item);
  }

  for (const u of updates as Update[]) {
    const row = working.find((i) => i.id === u.id);
    if (!row) continue; // unknown id: skipped, as the reducer would
    const oldQty = row.qty;
    const shares = row.placements ?? [];
    const wholeInOne = shares.length === 1 && shares[0]!.qty >= oldQty ? shares[0]!.bagId : null;
    if (u.qty !== undefined && u.qty !== oldQty) {
      ops.push({ t: "updateItem", id: row.id, patch: { qty: u.qty } });
      row.qty = u.qty;
    }
    if (u.bagId !== undefined && (u.bagId === null || bags.has(u.bagId))) {
      const placements = u.bagId ? [{ bagId: u.bagId, qty: row.qty }] : [];
      ops.push({ t: "setPlacements", id: row.id, placements });
      row.placements = placements;
    } else if (u.qty !== undefined && wholeInOne && row.qty !== oldQty) {
      // whole in one bag before, whole in it after: the share follows the qty
      const placements = [{ bagId: wholeInOne, qty: row.qty }];
      ops.push({ t: "setPlacements", id: row.id, placements });
      row.placements = placements;
    }
    if (u.folderId !== undefined && (u.folderId === null || folders.has(u.folderId)) && u.folderId !== row.folderId && !row.parentId) {
      const sortOrder = nextSortOrder(working, u.folderId);
      ops.push({ t: "moveItem", id: row.id, folderId: u.folderId, sortOrder });
      row.folderId = u.folderId;
      row.sortOrder = sortOrder;
    }
  }

  // nothing to do (every add a retry, every update a no-op): answer with where it stands
  if (!ops.length) return { version: list.version };
  const snapshot = await applyOpsByEditHash(hash, ops, db);
  if (!snapshot) throw notFound();
  return { version: snapshot.version };
});
