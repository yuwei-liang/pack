import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb, makeList, type TestDb } from "./helpers/db";
import { LISTS_DDL } from "../server/utils/db";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { deleteAccount } from "../server/utils/accountRepo";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { lists, listClaims, users } from "../server/db/schema";
import { sha256Hex } from "../server/utils/tokens";
import {
  CARRY_DDL,
  createCarry,
  listCarry,
  updateCarry,
} from "../server/utils/carryRepo";
import {
  acceptedCarryUnit,
  carryGear,
  carryWeight,
  selectedCarryRoots,
  type CarryRequest,
} from "../shared/carry";
import type { Item, ListData } from "../shared/types";
const context = vi.hoisted(() => ({ db: null as unknown as TestDb }));
vi.mock("../server/utils/db", async (original) => ({
  ...(await original<typeof import("../server/utils/db")>()),
  useAccountDb: async () => context.db,
}));
const sender = { id: 1, email: "sender@example.com" },
  recipient = { id: 2, email: "molly@example.com" },
  stranger = { id: 3, email: "other@example.com" };
const item = (
  id: string,
  name: string,
  weight: number,
  parentId?: string,
): Item => ({
  id,
  name,
  unitWeightMg: weight * 1000,
  qty: 1,
  parentId,
  folderId: null,
  classification: "base",
  sortOrder: 0,
});
let db: TestDb;
let src: Awaited<ReturnType<typeof makeList>>;
let data: ListData;
async function request(ids = ["kit"]) {
  return createCarry(sender, sha256Hex(src.editToken), {
    email: recipient.email,
    name: "Molly",
    ids,
    note: "帐篷我背，地垫希望你背。",
  });
}
async function received(id: string) {
  return (await listCarry(recipient)).find((r) => r.id === id)!;
}
function answer(
  r: CarryRequest,
  decision: "accepted" | "declined" = "accepted",
) {
  return {
    id: r.id,
    version: r.version,
    action: "reply",
    units: r.units.map((u) => ({ ...u, decision })),
    reply: "好的",
  };
}
beforeEach(async () => {
  db = await createTestDb(LISTS_DDL, ACCOUNT_DDL, VAULT_DDL, CARRY_DDL);
  context.db = db;
  await db.insert(users).values(
    [sender, recipient, stranger].map((u) => ({
      ...u,
      emailVerified: true,
      displayName: u.id === 1 ? "Yuwei" : "Molly",
    })),
  );
  data = {
    folders: [],
    items: [
      item("kit", "Cookset", 0),
      item("stove", "Stove", 184, "kit"),
      item("pot", "Pot", 229, "kit"),
      item("lid", "Lid", 44, "kit"),
      item("stand", "Stand", 33, "kit"),
      item("footprint", "Footprint", 384),
      item("private", "Private sleeping gear", 600),
    ],
  };
  src = await makeList(db, "Big Pine", { data });
});
describe("selective carry collaboration", () => {
  it("deduplicates parent and children; selecting a child grants no siblings", () => {
    expect(selectedCarryRoots(data, ["kit", "stove"])).toEqual(["kit"]);
    expect(carryWeight(carryGear(data, "kit"))).toBe(490000);
    expect(carryGear(data, "stove").map((g) => g.id)).toEqual(["stove"]);
  });
  it("works before the recipient has an account and grants only selected gear", async () => {
    await db.delete(users).where(eq(users.id, 2));
    const id = await request(["stove", "footprint"]);
    await db.insert(users).values({ ...recipient, emailVerified: true });
    const r = await received(id);
    expect(r.units.flatMap((u) => u.gear.map((g) => g.id))).toEqual([
      "stove",
      "footprint",
    ]);
    expect(JSON.stringify(r)).not.toContain(src.shareCode);
    expect(JSON.stringify(r)).not.toContain(src.editToken);
    expect(JSON.stringify(r)).not.toContain("Private sleeping");
    expect(r.note).toContain("帐篷我背");
  });
  it("requires verified email and denies unrelated accounts", async () => {
    const id = await request();
    expect(await listCarry(stranger)).toEqual([]);
    await expect(
      updateCarry(stranger, { id, version: 1, action: "cancel" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await db.update(users).set({ emailVerified: false }).where(eq(users.id, 2));
    await expect(listCarry(recipient)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it("requires the source edit capability and disallows self requests", async () => {
    await expect(
      createCarry(sender, "wrong", {
        email: recipient.email,
        name: "Molly",
        ids: ["kit"],
        note: "",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      createCarry(sender, sha256Hex(src.editToken), {
        email: sender.email,
        name: "Me",
        ids: ["kit"],
        note: "",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  it("atomically reserves gear under concurrent requests", async () => {
    const results = await Promise.allSettled([request(), request(["stove"])]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await db.execute(
      sql`SELECT count(*)::int AS n FROM carry_requests`,
    );
    expect(rows.rows[0]!.n).toBe(1);
  });
  it("accepts 874g without copying or editing the source list", async () => {
    const id = await request(["kit", "footprint"]);
    const r = await received(id);
    expect(r.units.every((u) => !acceptedCarryUnit(u))).toBe(true);
    await updateCarry(recipient, answer(r));
    const accepted = await received(id);
    expect(accepted.units.every(acceptedCarryUnit)).toBe(true);
    expect(accepted.units.reduce((n, u) => n + carryWeight(u.gear), 0)).toBe(
      874000,
    );
    expect(
      (await db.select().from(lists).where(eq(lists.id, src.id)))[0]!.data,
    ).toEqual(data);
  });
  it("persists independent groups, packed state and ordering; rejects stale updates", async () => {
    const id = await request();
    await updateCarry(recipient, answer(await received(id)));
    const r = await received(id);
    r.units[0]!.groups = { kit: "炊事", stove: "背包外侧" };
    r.units[0]!.packed = { stove: true };
    r.units[0]!.positions = { stove: -1000 };
    await updateCarry(recipient, { ...answer(r), action: "organize" });
    const saved = await received(id);
    expect(saved.units[0]!.groups.stove).toBe("背包外侧");
    expect(saved.units[0]!.packed.stove).toBe(true);
    expect(saved.units[0]!.positions?.stove).toBe(-1000);
    expect((await listCarry(sender))[0]!.units[0]!.groups).toEqual({});
    expect((await listCarry(sender))[0]!.units[0]!.packed).toEqual({});
    await expect(
      updateCarry(recipient, { ...answer(r), action: "organize" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (await db.select().from(lists).where(eq(lists.id, src.id)))[0]!.data,
    ).toEqual(data);
  });
  it("updates corrected weights live, and requires new consent for changed contents", async () => {
    const id = await request();
    await updateCarry(recipient, answer(await received(id)));
    data.items.find((i) => i.id === "pot")!.unitWeightMg = 240000;
    await db
      .update(lists)
      .set({ data, version: 2 })
      .where(eq(lists.id, src.id));
    let r = await received(id);
    expect(acceptedCarryUnit(r.units[0]!)).toBe(true);
    expect(carryWeight(r.units[0]!.gear)).toBe(501000);
    const stale = answer(r);
    data.items.push(item("extra", "Extra stove", 50, "kit"));
    await db
      .update(lists)
      .set({ data, version: 3 })
      .where(eq(lists.id, src.id));
    r = await received(id);
    expect(r.units[0]!.needsReview).toBe(true);
    expect(acceptedCarryUnit(r.units[0]!)).toBe(false);
    await expect(updateCarry(recipient, stale)).rejects.toMatchObject({
      statusCode: 409,
    });
    await updateCarry(recipient, answer(r));
    expect(acceptedCarryUnit((await received(id)).units[0]!)).toBe(true);
  });
  it("does not allow organizing to silently accept newly changed quantities", async () => {
    const id = await request();
    await updateCarry(recipient, answer(await received(id)));
    data.items.find((i) => i.id === "pot")!.qty = 2;
    await db
      .update(lists)
      .set({ data, version: 2 })
      .where(eq(lists.id, src.id));
    const r = await received(id);
    await updateCarry(recipient, { ...answer(r), action: "organize" });
    expect(acceptedCarryUnit((await received(id)).units[0]!)).toBe(false);
  });
  it("releases declined items and cancellation does not release another request", async () => {
    const old = await request(["stove"]);
    await updateCarry(recipient, answer(await received(old), "declined"));
    const next = await request(["stove"]);
    await updateCarry(sender, { id: old, version: 2, action: "cancel" });
    await expect(request(["stove"])).rejects.toMatchObject({ statusCode: 409 });
    await updateCarry(sender, { id: next, version: 1, action: "cancel" });
    await expect(request(["stove"])).resolves.toBeTypeOf("string");
  });
  it("rolls back reaccepting gear reserved by another request", async () => {
    const id = await request(["stove"]);
    await updateCarry(recipient, answer(await received(id), "declined"));
    await request(["stove"]);
    await expect(
      updateCarry(recipient, answer(await received(id))),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await received(id)).units[0]!.decision).toBe("declined");
    expect((await received(id)).version).toBe(2);
  });
  it("allows joining only recipient-owned lists without leaking that list to sender", async () => {
    const id = await request();
    const own = await makeList(db, "Molly private trip");
    await db.insert(listClaims).values({ userId: 2, listId: own.id });
    await updateCarry(recipient, {
      ...answer(await received(id)),
      destinationCode: own.shareCode,
    });
    expect((await received(id)).destinationCode).toBe(own.shareCode);
    expect((await listCarry(sender))[0]!.destinationCode).toBeUndefined();
    await expect(
      updateCarry(recipient, {
        ...answer(await received(id)),
        destinationCode: src.shareCode,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it("marks deleted gear unavailable and permits sender cancellation after source deletion", async () => {
    const id = await request();
    await updateCarry(recipient, answer(await received(id)));
    await db
      .update(lists)
      .set({ deletedAt: new Date() })
      .where(eq(lists.id, src.id));
    expect((await received(id)).units[0]!.unavailable).toBe(true);
    await updateCarry(sender, { id, version: 2, action: "cancel" });
    expect((await received(id)).cancelled).toBe(true);
  });
  it("rejects sender replies and recipient cancellation", async () => {
    const id = await request();
    await expect(
      updateCarry(sender, answer(await received(id))),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      updateCarry(recipient, { id, version: 1, action: "cancel" }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it("does not expand a single-item grant into new children, and cancellation revokes live gear", async () => {
    const id = await request(["stove"]);
    data.items.push(item("unselected", "Unselected new child", 25, "stove"));
    await db
      .update(lists)
      .set({ data, version: 2 })
      .where(eq(lists.id, src.id));
    expect((await received(id)).units[0]!.gear.map((g) => g.id)).toEqual([
      "stove",
    ]);
    await updateCarry(sender, { id, version: 1, action: "cancel" });
    expect((await received(id)).units[0]!.gear).toEqual([]);
  });
  it("account deletion removes received grants and reservations without touching the source gear", async () => {
    await request();
    await deleteAccount(db, recipient.id);
    expect(
      (await db.execute(sql`SELECT count(*)::int AS n FROM carry_requests`))
        .rows[0]!.n,
    ).toBe(0);
    expect(
      (await db.execute(sql`SELECT count(*)::int AS n FROM carry_reservations`))
        .rows[0]!.n,
    ).toBe(0);
    expect(
      (await db.select().from(lists).where(eq(lists.id, src.id)))[0]!.data,
    ).toEqual(data);
  });
  it("permanent list purge removes source grants and reservations", async () => {
    await request();
    await db.delete(lists).where(eq(lists.id, src.id));
    expect(await listCarry(recipient)).toEqual([]);
    expect(
      (await db.execute(sql`SELECT count(*)::int AS n FROM carry_reservations`))
        .rows[0]!.n,
    ).toBe(0);
  });
  it("rejects a stale source preview and never silently drops unsaved selected items", async () => {
    await expect(
      createCarry(sender, sha256Hex(src.editToken), {
        email: recipient.email,
        name: "Molly",
        ids: ["kit"],
        note: "",
        listVersion: 999,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(request(["kit", "unsaved"])).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(await listCarry(recipient)).toEqual([]);
  });
});
