// Which bag each thing travels in, and what each bag then weighs — the rules written
// ONCE. Folders say what a row IS (摄影, 洗漱); bags say where it TRAVELS (the 28"
// checked case, the cabin roller, the camera backpack). The two are orthogonal, so a
// row keeps its folder and separately carries `placements`: some of its quantity in
// one bag, some in another. The editor's by-bag view, packing mode, the exporters and
// the MCP connector all read placements through here, so "what's in the carry-on" has
// one answer. Pure and framework-free, like the rest of shared/.

import type { Bag, BagKind, Item, ListData, Placement } from "./types";
import { bySortOrder, isBareGroup } from "./weights";

/** The bag kinds' display names, in the order the picker offers them. */
export const BAG_KIND_LABELS: Record<BagKind, string> = {
  checked: "托运",
  "carry-on": "登机",
  personal: "随身小件",
  worn: "穿着",
};

// The reducer's own placement rules live in shared/ops.ts (healPlacements,
// packedFromPlacements, isBagKind), so the editor's first load carries the reducer
// and not this file — the views below are what the lazy by-bag view pulls in.
export { healPlacements, isBagKind, packedFromPlacements } from "./ops";

/** Bags in display order. sortOrder is the order, array order is insertion. */
export function sortedBags(bags?: readonly Bag[]): Bag[] {
  return [...(bags ?? [])].sort(bySortOrder);
}

/** The ids of rows that ARE a bag (the suitcase row itself). Such a row is the bag's
 *  empty weight, never content — it isn't "in" any bag, least of all its own. */
export function bagRowIds(bags?: readonly Bag[]): Set<string> {
  const out = new Set<string>();
  for (const b of bags ?? []) if (b.itemId) out.add(b.itemId);
  return out;
}

/** Of a row's qty, how many are placed in some bag by the row's OWN placements. */
export const placedQty = (placements: readonly Placement[] | undefined): number =>
  (placements ?? []).reduce((n, p) => n + p.qty, 0);

/** One share of a row as a bag holds it. `inherited` = the row has no placements of
 *  its own and travels with its parent; its tick is then the row's own `packed`. */
export interface EffectivePlacement extends Placement {
  inherited?: true;
}

/**
 * Where this row EFFECTIVELY travels. Its own placements when it has any; otherwise a
 * nested child goes wherever its parent goes — but only when that's one answer: the
 * parent sits whole in a single bag, or the parent IS a bag (rows nested under the
 * backpack row are in the backpack). A parent split across two bags leaves its
 * children to be placed themselves, because "half the poles in each" is a guess.
 *
 * Nesting is one level deep, so one parent hop is the whole resolution — the same
 * shape as effectivePersonId in shared/people.ts.
 */
export function effectivePlacements(
  item: Pick<Item, "placements" | "qty" | "packed">,
  parent: Pick<Item, "id" | "placements" | "qty"> | null | undefined,
  bags: readonly Bag[] | undefined,
): EffectivePlacement[] {
  if (item.placements?.length) return item.placements;
  if (!parent || item.qty <= 0) return [];
  const asBag = bags?.find((b) => b.itemId === parent.id);
  if (asBag) return [{ bagId: asBag.id, qty: item.qty, packed: item.packed, inherited: true }];
  const pp = parent.placements;
  if (pp?.length === 1 && pp[0]!.qty >= parent.qty)
    return [{ bagId: pp[0]!.bagId, qty: item.qty, packed: item.packed, inherited: true }];
  return [];
}

/** One row's share in one bag, as the by-bag view lists it. */
export interface BagEntry {
  item: Item;
  parent?: Item;
  qty: number;
  packed: boolean;
  inherited: boolean;
}

export interface BagSummary {
  bag: Bag;
  entries: BagEntry[];
  /** what the contents weigh: unit weight × the qty placed here, over every entry */
  contentsMg: number;
  /** the bag's own weight, from its row; 0 when it has no row or the row is unweighed */
  tareMg: number;
  totalMg: number;
  /** entries whose row has no weight yet — the total is a floor, not a figure */
  unweighed: number;
  /** the bag has a row but that row has no weight */
  tareUnweighed: boolean;
  over: boolean;
}

export interface UnplacedEntry {
  item: Item;
  parent?: Item;
  /** of the row's qty, how many aren't in any bag */
  qty: number;
}

export interface BagPlan {
  bags: BagSummary[];
  unplaced: UnplacedEntry[];
}

/**
 * Does this row take part in packing-into-bags at all? Not a bag's own row (it's the
 * tare), not a row with no quantity, and not a BARE GROUP — a container holding
 * nothing of its own is its children, which are placed (or inherit) row by row.
 */
function packable(item: Item, hasChildren: boolean, bagRows: Set<string>): boolean {
  return !bagRows.has(item.id) && item.qty > 0 && !isBareGroup(item, hasChildren);
}

/**
 * The whole by-bag picture: each bag with its contents and weights, and what's left
 * unplaced. One pass over the rows; every surface that shows a bag's weight reads it
 * from here so the header, the MCP read and the export agree.
 */
export function planBags(list: Pick<ListData, "items" | "bags"> & Partial<Pick<ListData, "folders">>): BagPlan {
  const bags = sortedBags(list.bags);
  const byId = new Map(list.items.map((i) => [i.id, i]));
  const parents = new Set<string>();
  for (const it of list.items) if (it.parentId) parents.add(it.parentId);
  const bagRows = bagRowIds(bags);
  const summaries = new Map<string, BagSummary>(
    bags.map((bag) => {
      const row = bag.itemId ? byId.get(bag.itemId) : undefined;
      const tareMg = row ? Math.max(0, row.unitWeightMg) : 0;
      return [
        bag.id,
        { bag, entries: [], contentsMg: 0, tareMg, totalMg: tareMg, unweighed: 0, tareUnweighed: !!row && tareMg === 0, over: false },
      ];
    }),
  );
  const unplaced: UnplacedEntry[] = [];
  // rows in list order — folder, then the row's place in it, a nested row right after
  // its parent — so a thing reads in the same order in the by-bag view as by folder
  const folderRank = new Map((list.folders ?? []).slice().sort(bySortOrder).map((f, i) => [f.id, i]));
  const rank = (it: Item): [number, number, number, number] => {
    const top = it.parentId ? (byId.get(it.parentId) ?? it) : it;
    return [folderRank.get(top.folderId ?? "") ?? -1, top.sortOrder, it.parentId ? 1 : 0, it.sortOrder];
  };
  const ordered = [...list.items].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < 4; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
    return 0;
  });
  for (const item of ordered) {
    if (!packable(item, parents.has(item.id), bagRows)) continue;
    const parent = item.parentId ? byId.get(item.parentId) : undefined;
    let placed = 0;
    for (const p of effectivePlacements(item, parent, bags)) {
      const s = summaries.get(p.bagId);
      if (!s) continue;
      placed += p.qty;
      s.entries.push({ item, parent, qty: p.qty, packed: !!p.packed, inherited: !!("inherited" in p && p.inherited) });
      const mg = Math.max(0, item.unitWeightMg) * p.qty;
      s.contentsMg += mg;
      s.totalMg += mg;
      if (item.unitWeightMg <= 0) s.unweighed++;
    }
    if (placed < item.qty) unplaced.push({ item, parent, qty: item.qty - placed });
  }
  for (const s of summaries.values()) s.over = s.bag.limitMg != null && s.totalMg > s.bag.limitMg;
  return { bags: [...summaries.values()], unplaced };
}

/** The bag names a row travels in, for the by-folder row's tag and the exporters:
 *  "MUJI 登机箱" for a whole row, "MUJI 登机箱 ×2 · 28 寸托运箱 ×2" for a split one. */
export function placementLabel(
  item: Pick<Item, "placements" | "qty" | "packed">,
  parent: Pick<Item, "id" | "placements" | "qty"> | null | undefined,
  bags: readonly Bag[] | undefined,
): string | undefined {
  const eff = effectivePlacements(item, parent, bags);
  if (!eff.length) return undefined;
  const name = (id: string) => bags?.find((b) => b.id === id)?.name ?? "";
  if (eff.length === 1 && eff[0]!.qty >= item.qty) return name(eff[0]!.bagId);
  return eff.map((p) => `${name(p.bagId)} ×${p.qty}`).join(" · ");
}
