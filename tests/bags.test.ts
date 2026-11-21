import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { lists, type ListRow } from "../server/db/schema";
import { LISTS_DDL, SNAPSHOTS_DDL } from "../server/utils/db";
import {
  applyOpsByEditHash,
  listSnapshotsByEditHash,
  restoreSnapshotByEditHash,
  rowToSnapshot,
} from "../server/utils/listRepo";
import { sha256Hex } from "../server/utils/tokens";
import { effectivePlacements, healPlacements, placementLabel, planBags } from "../shared/bags";
import { cloneListData } from "../shared/clone";
import { jsonToListImport, listToJson } from "../shared/exporters/json";
import { applyOps, MAX_BAGS } from "../shared/ops";
import { applyListDiff, diffListState } from "../shared/snapshotDiff";
import type { Bag, Item, ListData, ListState } from "../shared/types";
import { byToken, createTestDb, makeList } from "./helpers/db";

const applyOpsByEditToken = byToken(applyOpsByEditHash);
const listSnapshotsByEditToken = byToken(listSnapshotsByEditHash);
const restoreSnapshotByEditToken = byToken(restoreSnapshotByEditHash);

const state = (over: Partial<ListState> = {}): ListState => ({
  title: "Bangkok",
  displayUnit: "g",
  folders: [{ id: "f", name: "衣物", defaultClassification: "base", sortOrder: 0 }],
  items: [],
  people: [],
  bags: [],
  version: 1,
  ...over,
});

const item = (over: Partial<Item> = {}): Item => ({
  id: "i1",
  folderId: "f",
  name: "T 恤",
  unitWeightMg: 150_000,
  qty: 4,
  classification: null,
  sortOrder: 0,
  ...over,
});

const bag = (over: Partial<Bag> = {}): Bag => ({ id: "cabin", name: "MUJI 登机箱", kind: "carry-on", sortOrder: 0, ...over });
const checked = () => bag({ id: "big", name: "28 寸托运箱", kind: "checked", sortOrder: 1, limitMg: 23_000_000 });

describe("bag ops", () => {
  it("adds, updates and removes a bag", () => {
    const s = state();
    applyOps(s, [{ t: "addBag", bag: bag() }]);
    expect(s.bags).toHaveLength(1);
    applyOps(s, [{ t: "updateBag", id: "cabin", patch: { name: "  ", kind: "personal", limitMg: 10_000_000 } }]);
    expect(s.bags![0]).toMatchObject({ name: "MUJI 登机箱", kind: "personal", limitMg: 10_000_000 });
    applyOps(s, [{ t: "updateBag", id: "cabin", patch: { limitMg: null } }]);
    expect(s.bags![0]!.limitMg).toBeUndefined();
    applyOps(s, [{ t: "removeBag", id: "cabin" }]);
    expect(s.bags).toHaveLength(0);
  });

  it("refuses a duplicate id and holds the cap", () => {
    const s = state();
    applyOps(s, [{ t: "addBag", bag: bag() }, { t: "addBag", bag: bag({ name: "Other" }) }]);
    expect(s.bags).toHaveLength(1);
    for (let i = 0; i < MAX_BAGS + 3; i++) applyOps(s, [{ t: "addBag", bag: bag({ id: `b${i}` }) }]);
    expect(s.bags).toHaveLength(MAX_BAGS);
  });

  it("an unknown kind falls to carry-on", () => {
    const s = state();
    applyOps(s, [{ t: "addBag", bag: bag({ kind: "trunk" as never }) }]);
    expect(s.bags![0]!.kind).toBe("carry-on");
  });

  it("drops an owner who isn't on the trip and a row that isn't on the list", () => {
    const s = state({ people: [{ id: "y", name: "Yuwei", sortOrder: 0 }] });
    applyOps(s, [{ t: "addBag", bag: bag({ personId: "ghost", itemId: "nope" }) }]);
    expect(s.bags![0]!.personId).toBeUndefined();
    expect(s.bags![0]!.itemId).toBeUndefined();
    applyOps(s, [{ t: "updateBag", id: "cabin", patch: { personId: "y" } }]);
    expect(s.bags![0]!.personId).toBe("y");
    applyOps(s, [{ t: "removePerson", id: "y" }]);
    expect(s.bags![0]!.personId).toBeUndefined();
  });

  it("a bag's row is its empty weight and can't be content", () => {
    const s = state({ items: [item({ id: "roller", name: "MUJI 登机箱", qty: 1, unitWeightMg: 3_100_000, placements: [{ bagId: "x", qty: 1 }] })] });
    applyOps(s, [{ t: "addBag", bag: checked() }, { t: "setPlacements", id: "roller", placements: [{ bagId: "big", qty: 1 }] }]);
    expect(s.items[0]!.placements).toEqual([{ bagId: "big", qty: 1 }]);
    applyOps(s, [{ t: "addBag", bag: bag({ itemId: "roller" }) }]);
    expect(s.items[0]!.placements).toBeUndefined();
    // a second bag can't claim the same row
    applyOps(s, [{ t: "updateBag", id: "big", patch: { itemId: "roller" } }]);
    expect(s.bags!.find((b) => b.id === "big")!.itemId).toBeUndefined();
    // the row deleted: the bag stays, weightless
    applyOps(s, [{ t: "removeItem", id: "roller" }]);
    expect(s.bags!.find((b) => b.id === "cabin")!.itemId).toBeUndefined();
  });
});

describe("placements", () => {
  it("splits a row's quantity between bags", () => {
    const s = state({ items: [item()], bags: [bag(), checked()] });
    applyOps(s, [{ t: "setPlacements", id: "i1", placements: [{ bagId: "cabin", qty: 2 }, { bagId: "big", qty: 2 }] }]);
    expect(s.items[0]!.placements).toEqual([{ bagId: "cabin", qty: 2 }, { bagId: "big", qty: 2 }]);
  });

  it("never sums past qty, merges a repeated bag and drops unknown bags", () => {
    const s = state({ items: [item()], bags: [bag(), checked()] });
    applyOps(s, [
      {
        t: "setPlacements",
        id: "i1",
        placements: [{ bagId: "cabin", qty: 1 }, { bagId: "ghost", qty: 3 }, { bagId: "cabin", qty: 1 }, { bagId: "big", qty: 9 }],
      },
    ]);
    expect(s.items[0]!.placements).toEqual([{ bagId: "cabin", qty: 2 }, { bagId: "big", qty: 2 }]);
  });

  it("a qty cut trims the shares from the end", () => {
    const s = state({ items: [item()], bags: [bag(), checked()] });
    applyOps(s, [
      { t: "setPlacements", id: "i1", placements: [{ bagId: "cabin", qty: 2 }, { bagId: "big", qty: 2 }] },
      { t: "updateItem", id: "i1", patch: { qty: 3 } },
    ]);
    expect(s.items[0]!.placements).toEqual([{ bagId: "cabin", qty: 2 }, { bagId: "big", qty: 1 }]);
  });

  it("[] clears, and the key goes absent", () => {
    const s = state({ items: [item()], bags: [bag()] });
    applyOps(s, [
      { t: "setPlacements", id: "i1", placements: [{ bagId: "cabin", qty: 4 }] },
      { t: "setPlacements", id: "i1", placements: [] },
    ]);
    expect("placements" in s.items[0]!).toBe(false);
  });

  it("removing a bag sends its share back to unplaced; the row survives", () => {
    const s = state({ items: [item()], bags: [bag(), checked()] });
    applyOps(s, [
      { t: "setPlacements", id: "i1", placements: [{ bagId: "cabin", qty: 2 }, { bagId: "big", qty: 2 }] },
      { t: "removeBag", id: "cabin" },
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]!.placements).toEqual([{ bagId: "big", qty: 2 }]);
  });

  it("an addItem holds its placements to the list's bags", () => {
    const s = state({ bags: [bag()] });
    applyOps(s, [{ t: "addItem", item: item({ placements: [{ bagId: "cabin", qty: 1 }, { bagId: "ghost", qty: 1 }] }) }]);
    expect(s.items[0]!.placements).toEqual([{ bagId: "cabin", qty: 1 }]);
  });
});

describe("packing by bag", () => {
  it("a share's tick packs the row only when every share is in", () => {
    const s = state({ items: [item()], bags: [bag(), checked()] });
    applyOps(s, [{ t: "setPlacements", id: "i1", placements: [{ bagId: "cabin", qty: 2 }, { bagId: "big", qty: 2 }] }]);
    applyOps(s, [{ t: "packPlacement", id: "i1", bagId: "cabin", packed: true }]);
    expect(s.items[0]!.packed).toBe(false);
    applyOps(s, [{ t: "packPlacement", id: "i1", bagId: "big", packed: true }]);
    expect(s.items[0]!.packed).toBe(true);
    applyOps(s, [{ t: "packPlacement", id: "i1", bagId: "big", packed: false }]);
    expect(s.items[0]!.packed).toBe(false);
  });

  it("a tick in the folder view packs every share", () => {
    const s = state({ items: [item()], bags: [bag(), checked()] });
    applyOps(s, [
      { t: "setPlacements", id: "i1", placements: [{ bagId: "cabin", qty: 2 }, { bagId: "big", qty: 2 }] },
      { t: "updateItem", id: "i1", patch: { packed: true } },
    ]);
    expect(s.items[0]!.placements!.every((p) => p.packed)).toBe(true);
  });

  it("re-splitting keeps the tick of a share that stayed in its bag", () => {
    const s = state({ items: [item()], bags: [bag(), checked()] });
    applyOps(s, [
      { t: "setPlacements", id: "i1", placements: [{ bagId: "cabin", qty: 4 }] },
      { t: "packPlacement", id: "i1", bagId: "cabin", packed: true },
      { t: "setPlacements", id: "i1", placements: [{ bagId: "cabin", qty: 2 }, { bagId: "big", qty: 2 }] },
    ]);
    expect(s.items[0]!.placements).toEqual([{ bagId: "cabin", qty: 2, packed: true }, { bagId: "big", qty: 2 }]);
    expect(s.items[0]!.packed).toBe(false);
  });
});

describe("planBags", () => {
  const list = (): ListData => ({
    folders: [
      { id: "f", name: "衣物", defaultClassification: "base", sortOrder: 0 },
      { id: "p", name: "背包", defaultClassification: "base", sortOrder: 1 },
    ],
    people: [],
    bags: [bag({ itemId: "roller", limitMg: 1_000_000 }), checked()],
    items: [
      item({ placements: [{ bagId: "cabin", qty: 2 }, { bagId: "big", qty: 2 }] }),
      item({ id: "shorts", name: "短裤", qty: 3, unitWeightMg: 0, sortOrder: 1, placements: [{ bagId: "big", qty: 3 }] }),
      item({ id: "hat", name: "遮阳帽", qty: 1, unitWeightMg: 30_000, sortOrder: 2 }),
      item({ id: "roller", folderId: "p", name: "MUJI 登机箱", qty: 1, unitWeightMg: 3_000_000 }),
    ],
  });

  it("weighs each bag as its contents plus its own row", () => {
    const plan = planBags(list());
    const [cabin, big] = plan.bags;
    expect(cabin!.contentsMg).toBe(300_000);
    expect(cabin!.tareMg).toBe(3_000_000);
    expect(cabin!.totalMg).toBe(3_300_000);
    expect(cabin!.over).toBe(true); // a 1 kg limit
    expect(big!.contentsMg).toBe(300_000);
    expect(big!.unweighed).toBe(1); // the shorts
    expect(big!.over).toBe(false);
  });

  it("lists what isn't in a bag yet, and never the bag row itself", () => {
    const plan = planBags(list());
    expect(plan.unplaced.map((u) => [u.item.id, u.qty])).toEqual([["hat", 1]]);
  });

  it("a nested row goes where its parent goes, when that's one bag", () => {
    const l = list();
    l.items.push(
      item({ id: "kit", name: "剃须套装", qty: 1, unitWeightMg: 0, sortOrder: 5, placements: [{ bagId: "big", qty: 1 }] }),
      item({ id: "razor", parentId: "kit", name: "Safety razor", qty: 1, unitWeightMg: 80_000 }),
      item({ id: "brush", parentId: "kit", name: "剃须刷", qty: 1, unitWeightMg: 40_000, placements: [{ bagId: "cabin", qty: 1 }] }),
    );
    const plan = planBags(l);
    const big = plan.bags[1]!;
    expect(big.entries.map((e) => e.item.id)).toContain("razor");
    expect(big.entries.find((e) => e.item.id === "razor")!.inherited).toBe(true);
    // the bare group itself is not an entry — its children are
    expect(big.entries.map((e) => e.item.id)).not.toContain("kit");
    expect(plan.bags[0]!.entries.map((e) => e.item.id)).toContain("brush");
  });

  it("rows nested under a bag's own row are in that bag", () => {
    const l = list();
    l.items.push(item({ id: "cable", parentId: "roller", folderId: "p", name: "USB-C 线", qty: 2, unitWeightMg: 20_000 }));
    const cabin = planBags(l).bags[0]!;
    expect(cabin.entries.find((e) => e.item.id === "cable")!.qty).toBe(2);
  });

  it("a parent split between bags leaves its children to be placed", () => {
    const parent = item({ id: "kit", qty: 2, placements: [{ bagId: "a", qty: 1 }, { bagId: "b", qty: 1 }] });
    expect(effectivePlacements(item({ id: "c", parentId: "kit" }), parent, [])).toEqual([]);
  });

  it("labels a split row by bag and count", () => {
    const l = list();
    expect(placementLabel(l.items[0]!, null, l.bags)).toBe("MUJI 登机箱 ×2 · 28 寸托运箱 ×2");
    expect(placementLabel(l.items[1]!, null, l.bags)).toBe("28 寸托运箱");
    expect(placementLabel(l.items[2]!, null, l.bags)).toBeUndefined();
  });

  it("healPlacements returns undefined for nothing placed", () => {
    expect(healPlacements([], 3, new Set(["a"]))).toBeUndefined();
    expect(healPlacements("junk", 3, new Set(["a"]))).toBeUndefined();
  });
});

describe("bags on every path", () => {
  const data = (): ListData => ({
    folders: [{ id: "f", name: "衣物", defaultClassification: "base", sortOrder: 0 }],
    people: [{ id: "y", name: "Yuwei", sortOrder: 0 }],
    bags: [bag({ personId: "y", itemId: "roller" }), checked()],
    items: [
      item({ placements: [{ bagId: "cabin", qty: 2, packed: true }, { bagId: "big", qty: 2 }] }),
      item({ id: "roller", name: "MUJI 登机箱", qty: 1, sortOrder: 1 }),
    ],
  });

  it("the share view sees the bags but not the ticks in them", () => {
    const snap = rowToSnapshot({ data: data(), title: "t", displayUnit: "g", version: 1, shareCode: "X", publicSlug: "s", isPublic: false } as unknown as ListRow);
    expect(snap.bags).toHaveLength(2);
    expect(snap.items[0]!.placements).toEqual([{ bagId: "cabin", qty: 2 }, { bagId: "big", qty: 2 }]);
  });

  it("a JSON backup round-trips the bags and every reference", () => {
    const back = jsonToListImport(listToJson({ title: "t", displayUnit: "g", ...data() }))!;
    const [cabin, big] = back.data.bags!;
    const roller = back.data.items.find((i) => i.name === "MUJI 登机箱")!;
    expect(cabin!.itemId).toBe(roller.id);
    expect(cabin!.personId).toBe(back.data.people![0]!.id);
    expect(back.data.items[0]!.placements!.map((p) => p.bagId)).toEqual([cabin!.id, big!.id]);
  });

  it("a duplicate keeps the plan with fresh ids and no ticks", () => {
    const copy = cloneListData({ ...data(), days: [], waypoints: [] });
    expect(copy.bags).toHaveLength(2);
    expect(copy.bags[0]!.id).not.toBe("cabin");
    expect(copy.items[0]!.placements).toEqual([{ bagId: copy.bags[0]!.id, qty: 2 }, { bagId: copy.bags[1]!.id, qty: 2 }]);
    expect(copy.bags[0]!.itemId).toBe(copy.items[1]!.id);
  });

  it("the recovery-point diff carries bags", () => {
    const a = { ...state(), ...data() };
    const b = structuredClone(a);
    b.bags = [checked()];
    const diff = diffListState(a, b);
    const back = applyListDiff(structuredClone(a), diff);
    expect(back.bags).toEqual([checked()]);
  });

  it("bags survive an unrelated edit, and a restore brings them back", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { editToken } = await makeList(db, "Bags trip", { data: data() });
    await applyOpsByEditToken(editToken, [{ t: "updateItem", id: "i1", patch: { name: "T 恤 2" } }], db);
    const read = async () => {
      const [r] = await db.select().from(lists).where(eq(lists.editTokenHash, sha256Hex(editToken)));
      return r!.data as ListData;
    };
    expect((await read()).bags).toHaveLength(2);
    expect((await read()).items[0]!.placements![0]!.packed).toBe(true);
    await applyOpsByEditToken(editToken, [{ t: "removeBag", id: "cabin" }], db);
    expect((await read()).bags).toHaveLength(1);
    const snaps = await listSnapshotsByEditToken(editToken, db);
    const restored = await restoreSnapshotByEditToken(editToken, snaps![0]!.id, db);
    expect(restored!.bags).toHaveLength(2);
    expect(restored!.items.find((i) => i.id === "i1")!.placements).toHaveLength(2);
  });
});
