// Kits in My Gear, phase 1 (docs/design/my-gear-kits.md): a kit is a vault row that
// points at its parts, and its weight is derived from them. What is pinned here is
// the arithmetic (own + live parts × qty), the rules that keep a kit one level deep
// and inside its own vault, and the guards that stop an automatic write from putting
// a kit's typed total back into its own weight — which would count every part twice.

import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { vaultItems, vaultKitParts, vaults } from "../server/db/schema";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import {
  applyVaultItemOp,
  captureVaultItems,
  captureVaultItemsReporting,
  getVaultItem,
  listRemovedVaultItems,
  listVaultItems,
  purgeDeletedVaults,
  removeVaultItem,
  restoreVaultItem,
  searchVaultItems,
  setKitParts,
  vaultGearAmong,
} from "../server/utils/vaultRepo";
import { captureFromList, vaultNormKey, type VaultEntry } from "../shared/vault";
import type { Item } from "../shared/types";
import { createTestDb, type TestDb } from "./helpers/db";

let db: TestDb;
let vault = 0;

async function newVault(): Promise<number> {
  const [v] = await db.insert(vaults).values({}).returning();
  return v!.id;
}

/** Add a piece by hand, the way /gear's add row does; returns its id. */
async function piece(name: string, grams: number, vaultId = vault): Promise<number> {
  const res = await applyVaultItemOp(db, vaultId, { t: "add", name, weightMg: grams * 1000 });
  if (!res || !("item" in res)) throw new Error(`could not add ${name}`);
  return res.item.id;
}

const byId = (rows: VaultEntry[], id: number) => rows.find((r) => r.id === id)!;

/** The owner's camera kit from the design doc, converted in place. */
async function cameraKit() {
  const body = await piece("X-S20 body", 424);
  const cage = await piece("SmallRig cage", 140);
  const battery = await piece("NP-W235", 81);
  const plateA = await piece("Peak Design plate", 14);
  const plateB = await piece("Ulanzi plate", 14);
  const lens = await piece("XF 16-55 II", 453);
  // the hand-typed row, whose 1,126 g was the sum, typed in
  const kit = await piece("X-S20 + XF 16-55 II kit", 1126);
  const ok = await setKitParts(
    db,
    vault,
    kit,
    [{ id: body }, { id: cage }, { id: plateA }, { id: plateB }, { id: battery }, { id: lens }],
    { ownWeightMg: 0 },
  );
  expect(ok).toBe(true);
  return { body, cage, battery, plateA, plateB, lens, kit };
}

beforeEach(async () => {
  db = await createTestDb(VAULT_DDL);
  vault = await newVault();
});

describe("a kit's weight is its parts'", () => {
  it("derives the total from its parts and lists them in order", async () => {
    const k = await cameraKit();
    const rows = await listVaultItems(db, vault);
    const kit = byId(rows, k.kit);
    expect(kit.kind).toBe("kit");
    expect(kit.ownWeightMg).toBe(0);
    expect(kit.weightMg).toBe(1_126_000);
    expect(kit.parts!.map((p) => p.id)).toEqual([k.body, k.cage, k.plateA, k.plateB, k.battery, k.lens]);
    expect(kit.parts![0]).toMatchObject({ name: "X-S20 body", qty: 1, weightMg: 424_000 });
    // a piece says which kits it's in; a piece in none says nothing
    expect(byId(rows, k.battery).inKits).toEqual([k.kit]);
    expect(byId(rows, k.battery).kind).toBeUndefined();
  });

  it("adds its own weight and counts a part by its qty", async () => {
    const battery = await piece("NP-W126S", 47);
    const charger = await piece("Charger", 150);
    const kit = await piece("Charger + 2 batteries", 0);
    expect(await setKitParts(db, vault, kit, [{ id: charger }, { id: battery, qty: 2 }], { ownWeightMg: 20_000 })).toBe(true);
    const got = (await getVaultItem(db, vault, kit))!;
    expect(got.weightMg).toBe(20_000 + 150_000 + 2 * 47_000);
    expect(got.parts!.find((p) => p.id === battery)!.qty).toBe(2);
  });

  it("follows a re-weighed part the next time it is read", async () => {
    const k = await cameraKit();
    await applyVaultItemOp(db, vault, { t: "edit", id: k.battery, patch: { weightMg: 83_000 } });
    expect((await getVaultItem(db, vault, k.kit))!.weightMg).toBe(1_128_000);
  });

  it("stops counting a part that is put away, and counts it again when it's back", async () => {
    const k = await cameraKit();
    await removeVaultItem(db, vault, k.lens);
    const kit = byId(await listVaultItems(db, vault), k.kit);
    expect(kit.weightMg).toBe(1_126_000 - 453_000);
    // still listed, marked
    expect(kit.parts!.find((p) => p.id === k.lens)).toMatchObject({ removed: true });
    await restoreVaultItem(db, vault, k.lens);
    expect((await getVaultItem(db, vault, k.kit))!.weightMg).toBe(1_126_000);
  });

  it("lets one piece belong to several kits", async () => {
    const battery = await piece("NP-W235", 81);
    const body = await piece("X-S20 body", 424);
    const mic = await piece("Mic", 60);
    const photo = await piece("Photo kit", 0);
    const video = await piece("Video kit", 0);
    expect(await setKitParts(db, vault, photo, [{ id: body }, { id: battery }], { ownWeightMg: 0 })).toBe(true);
    expect(await setKitParts(db, vault, video, [{ id: body }, { id: battery }, { id: mic }], { ownWeightMg: 0 })).toBe(true);
    const rows = await listVaultItems(db, vault);
    expect(byId(rows, battery).inKits).toEqual([photo, video].sort((a, b) => a - b));
    expect(byId(rows, photo).weightMg).toBe(505_000);
    expect(byId(rows, video).weightMg).toBe(565_000);
    // a kit that's put away no longer claims its pieces
    await removeVaultItem(db, vault, video);
    expect(byId(await listVaultItems(db, vault), battery).inKits).toEqual([photo]);
    // and still reads whole in the removed list
    expect(byId(await listRemovedVaultItems(db, vault), video).weightMg).toBe(565_000);
  });

  it("carries the kit fields through search and an edit's answer", async () => {
    const k = await cameraKit();
    const [hit] = await searchVaultItems(db, vault, "16-55 II kit");
    expect(hit).toMatchObject({ id: k.kit, kind: "kit", weightMg: 1_126_000 });
    const renamed = await applyVaultItemOp(db, vault, { t: "edit", id: k.kit, patch: { name: "Camera kit" } });
    expect(renamed && "item" in renamed && renamed.item).toMatchObject({ name: "Camera kit", weightMg: 1_126_000 });
  });
});

describe("the rules a kit keeps", () => {
  it("refuses a part from another vault, a kit as a part, a kit as its own part, and no parts", async () => {
    const other = await newVault();
    const theirs = await piece("Their stove", 80, other);
    const mine = await piece("My pot", 100);
    const kit = await piece("Cook kit", 0);
    const second = await piece("Second kit", 0);
    expect(await setKitParts(db, vault, kit, [{ id: mine }, { id: theirs }], { ownWeightMg: 0 })).toBe(false);
    expect(await setKitParts(db, vault, kit, [{ id: kit }], { ownWeightMg: 0 })).toBe(false);
    expect(await setKitParts(db, vault, kit, [], { ownWeightMg: 0 })).toBe(false);
    // nothing was half-made by the refusals above
    expect((await getVaultItem(db, vault, kit))!.kind).toBeUndefined();

    expect(await setKitParts(db, vault, kit, [{ id: mine }], { ownWeightMg: 0 })).toBe(true);
    // one level deep: a kit can't be a part, and a part can't become a kit
    expect(await setKitParts(db, vault, second, [{ id: kit }], { ownWeightMg: 0 })).toBe(false);
    expect(await setKitParts(db, vault, mine, [{ id: second }], { ownWeightMg: 0 })).toBe(false);
    // someone else's vault can't touch it
    expect(await setKitParts(db, other, kit, [{ id: theirs }], { ownWeightMg: 0 })).toBe(false);
  });

  it("refuses a weight edit on a kit but takes a rename", async () => {
    const k = await cameraKit();
    expect(await applyVaultItemOp(db, vault, { t: "edit", id: k.kit, patch: { weightMg: 1_126_000 } })).toBeNull();
    const [row] = await db.select().from(vaultItems).where(eq(vaultItems.id, k.kit));
    expect(Number(row!.weightMg)).toBe(0);
  });

  it("re-adding a put-away kit by name brings it back without the typed weight", async () => {
    const k = await cameraKit();
    await removeVaultItem(db, vault, k.kit);
    const res = await applyVaultItemOp(db, vault, { t: "add", name: "X-S20 + XF 16-55 II kit", weightMg: 1_126_000 });
    expect(res && "item" in res && res.item).toMatchObject({ kind: "kit", ownWeightMg: 0, weightMg: 1_126_000 });
  });

  it("purges a vault's kit links with the vault", async () => {
    await cameraKit();
    await db.update(vaults).set({ deletedAt: new Date(Date.now() - 400 * 86_400_000) }).where(eq(vaults.id, vault));
    const keep = await newVault();
    const pot = await piece("Pot", 100, keep);
    const cook = await piece("Cook kit", 0, keep);
    await setKitParts(db, keep, cook, [{ id: pot }], { ownWeightMg: 0 });

    await purgeDeletedVaults(db, { graceDays: 30 });
    const links = await db.select().from(vaultKitParts);
    expect(links).toEqual([expect.objectContaining({ kitId: cook, partId: pot })]);
  });
});

describe("capture leaves a kit's weight alone", () => {
  const row = (name: string, grams: number, over: Partial<Item> = {}): Item => ({
    id: `i-${name}`,
    folderId: null,
    name,
    unitWeightMg: grams * 1000,
    qty: 1,
    classification: null,
    sortOrder: 0,
    ...over,
  });

  // The design's §9 risk 1: many lists still hold the old single kit row. Without
  // the guard, the first capture would fill the kit's own weight of 0 with 1,126 g.
  it("a list holding the old single kit row writes no weight into the kit", async () => {
    const k = await cameraKit();
    const before = (await getVaultItem(db, vault, k.kit))!;
    const caps = captureFromList([row("X-S20 + XF 16-55 II kit", 1126), row("X-S20 body", 424)]);
    expect(caps.map((c) => c.normKey)).toContain(vaultNormKey(undefined, "X-S20 + XF 16-55 II kit", undefined));

    await captureVaultItems(db, vault, caps);
    const after = (await getVaultItem(db, vault, k.kit))!;
    expect(after.ownWeightMg).toBe(0);
    expect(after.weightMg).toBe(1_126_000);
    // usage still moves
    expect(after.timesSeen).toBe(before.timesSeen + 1);
    // membership survives a capture
    expect(after.parts).toHaveLength(6);
  });

  it("even a deliberate Save to My Gear can't, and the kit reports nothing to push", async () => {
    const k = await cameraKit();
    const { keys } = await captureVaultItemsReporting(db, vault, captureFromList([row("X-S20 + XF 16-55 II kit", 1500)]), {
      overwriteWeight: true,
    });
    expect((await getVaultItem(db, vault, k.kit))!.ownWeightMg).toBe(0);
    const key = vaultNormKey(undefined, "X-S20 + XF 16-55 II kit", undefined);
    expect(keys).toEqual([[key, null]]);
    expect(await vaultGearAmong(db, vault, [key])).toEqual([[key, null]]);
  });

  it("a list holding a kit as a group captures only its pieces", async () => {
    const k = await cameraKit();
    const items = [
      row("X-S20 + XF 16-55 II kit", 0, { id: "g" }),
      row("X-S20 body", 430, { parentId: "g" }),
      row("New strap", 30, { parentId: "g" }),
    ];
    await captureVaultItems(db, vault, captureFromList(items));
    const rows = await listVaultItems(db, vault);
    // the group is not gear; the renamed/new child is a new piece no kit includes
    expect(byId(rows, k.kit).parts).toHaveLength(6);
    expect(rows.find((r) => r.name === "New strap")!.inKits).toBeUndefined();
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from vault_kit_parts`)).rows as { n: number }[];
    expect(n).toBe(6);
  });
});
