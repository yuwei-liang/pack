import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEvent, type H3Event } from "h3";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import packed from "../server/api/app/packed.post";
import rows from "../server/api/app/rows.post";
import sync from "../server/api/app/sync.get";
import { createAccessToken, revokeAccessToken } from "../server/utils/accessTokens";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { claimLists } from "../server/utils/claimRepo";
import { LISTS_DDL } from "../server/utils/db";
import { mintVault } from "../server/utils/vaultAuth";
import { captureVaultItems } from "../server/utils/vaultRepo";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { CATALOG_DDL } from "../server/utils/catalog";
import { createTestDb, makeList } from "./helpers/db";

// The owner's native app, end to end against a real (in-memory) database: an access
// token reads the account's claimed lists and gear, and a write token sends packing
// ticks back through the editor's own op path. What is pinned is the reach — claimed
// and live lists only, the token's own account, write scope for the write — and that
// a tick lands exactly as the editor's would (row, share, version).

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../server/utils/db", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../server/utils/db")>();
  const grab = async () => state.db;
  return { ...mod, useDb: grab, useCatalogDb: grab, useVaultDb: grab, useAccountDb: grab };
});
vi.mock("../server/utils/rateLimit", () => ({
  rateLimit: async () => {},
  rateLimitSubject: async () => {},
  useKv: () => ({ getItem: async () => null, setItem: async () => {} }),
}));

function event(url: string, { method = "GET", token, body }: { method?: string; token?: string; body?: unknown } = {}): H3Event {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = url;
  const buf = body === undefined ? null : Buffer.from(JSON.stringify(body));
  req.headers = {
    host: "mahonia.test",
    ...(buf ? { "content-type": "application/json", "content-length": String(buf.length) } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  if (buf) req.push(buf);
  req.push(null);
  return createEvent(req, new ServerResponse(req));
}

/** Run a handler; a thrown h3 error comes back as its status rather than a throw. */
async function run<T>(handler: (e: H3Event) => unknown, e: H3Event): Promise<{ status: number; body: T; e: H3Event }> {
  try {
    const body = (await handler(e)) as T;
    return { status: e.node.res.statusCode, body, e };
  } catch (err) {
    return { status: (err as { statusCode?: number }).statusCode ?? 500, body: undefined as T, e };
  }
}

type Db = Awaited<ReturnType<typeof createTestDb>>;
type SyncBody = {
  format: string;
  version: number;
  syncedAt: string;
  lists: Array<{ shareCode: string; version: number; title: string; items: Array<Record<string, unknown>>; folders: Array<Record<string, unknown>>; bags: Array<Record<string, unknown>> }>;
  gear: { folders: unknown[]; items: Array<Record<string, unknown>> };
};

let db: Db;
let me = 0;
let fresh = 0;
let readToken = "";
let writeToken = "";
let freshToken = "";
let strangerToken = "";
let mine = { shareCode: "", editToken: "" };
let theirs = { shareCode: "", editToken: "" };
let unclaimed = { shareCode: "", editToken: "" };

const DATA = {
  folders: [{ id: "f1", name: "Shelter", defaultClassification: "base" as const, sortOrder: 0 }],
  items: [
    { id: "i1", folderId: "f1", name: "Duplex", brand: "Zpacks", unitWeightMg: 538_000, qty: 1, classification: null, sortOrder: 0 },
    {
      id: "i2",
      folderId: "f1",
      name: "Stake",
      unitWeightMg: 10_000,
      qty: 4,
      classification: null,
      sortOrder: 1,
      placements: [
        { bagId: "b1", qty: 2 },
        { bagId: "b2", qty: 2 },
      ],
    },
  ],
  bags: [
    { id: "b1", name: "Cabin", kind: "carry-on", sortOrder: 0 },
    { id: "b2", name: "Checked", kind: "checked", sortOrder: 1 },
  ],
};

beforeAll(async () => {
  db = await createTestDb(LISTS_DDL, ACCOUNT_DDL, VAULT_DDL, CATALOG_DDL);
  state.db = db;
  const users = await db
    .insert(schema.users)
    .values([{ email: "me@example.com" }, { email: "them@example.com" }, { email: "new@example.com" }])
    .returning();
  me = users[0]!.id;
  const stranger = users[1]!.id;
  fresh = users[2]!.id;
  readToken = (await createAccessToken(db, me, { scope: "read" }))!.token;
  writeToken = (await createAccessToken(db, me, { scope: "write" }))!.token;
  strangerToken = (await createAccessToken(db, stranger, { scope: "write" }))!.token;
  freshToken = (await createAccessToken(db, fresh, { scope: "read" }))!.token;

  mine = await makeList(db, "Timberline", { data: DATA as never, itemCount: 2, version: 1 });
  theirs = await makeList(db, "Theirs", { data: DATA as never, itemCount: 2, version: 1 });
  unclaimed = await makeList(db, "Nobody's", { data: DATA as never, itemCount: 2, version: 1 });
  expect(await claimLists(db as never, me, [mine.editToken])).toBe(1);
  expect(await claimLists(db as never, stranger, [theirs.editToken])).toBe(1);

  const vaultId = await mintVault(db as never, me);
  await captureVaultItems(db as never, vaultId, [{ name: "Duplex", brand: "Zpacks", weightMg: 538_000, classification: "base" } as never]);
});

describe("GET /api/app/sync", () => {
  it("returns the account's claimed lists with handles, ids, bags and packing state, and its gear", async () => {
    const { status, body, e } = await run<SyncBody>(sync, event("/api/app/sync", { token: readToken }));
    expect(status).toBe(200);
    expect(e.node.res.getHeader("cache-control")).toBe("private, no-store");
    expect(body.format).toBe("mahonia-app-sync");
    expect(body.version).toBe(1);
    expect(Number.isNaN(Date.parse(body.syncedAt))).toBe(false);
    expect(body.lists.map((l) => l.shareCode)).toEqual([mine.shareCode]);
    const list = body.lists[0]!;
    expect(list.version).toBe(1);
    expect(list.folders.map((f) => f.id)).toEqual(["f1"]);
    expect(list.bags.map((b) => b.id)).toEqual(["b1", "b2"]);
    const stake = list.items.find((i) => i.id === "i2")!;
    expect(stake).toMatchObject({ folderId: "f1", unitWeightMg: 10_000, qty: 4 });
    expect(stake.placements).toEqual([
      { bagId: "b1", qty: 2 },
      { bagId: "b2", qty: 2 },
    ]);
    expect(body.gear.items).toHaveLength(1);
    expect(body.gear.items[0]).toMatchObject({ name: "Duplex", brand: "Zpacks", weightMg: 538_000 });
    expect(typeof body.gear.items[0]!.id).toBe("number");
    expect(JSON.stringify(body)).not.toMatch(/editToken|editTokenHash|edit_token/);
  });

  it("gives a fresh account with no vault an empty gear half, not an error", async () => {
    const { status, body } = await run<SyncBody>(sync, event("/api/app/sync", { token: freshToken }));
    expect(status).toBe(200);
    expect(body.lists).toEqual([]);
    expect(body.gear).toEqual({ folders: [], items: [] });
  });

  it("refuses a missing, foreign-shaped or revoked token with 401", async () => {
    expect((await run(sync, event("/api/app/sync"))).status).toBe(401);
    expect((await run(sync, event("/api/app/sync", { token: "not-ours" }))).status).toBe(401);
    expect((await run(sync, event("/api/app/sync", { token: "pack_never-issued" }))).status).toBe(401);
    const gone = (await createAccessToken(db, me, { scope: "read" }))!;
    expect((await run(sync, event("/api/app/sync", { token: gone.token }))).status).toBe(200);
    await revokeAccessToken(db, me, gone.id);
    expect((await run(sync, event("/api/app/sync", { token: gone.token }))).status).toBe(401);
  });
});

describe("POST /api/app/packed", () => {
  const post = (token: string | undefined, body: unknown) =>
    run<{ version: number }>(packed, event("/api/app/packed", { method: "POST", token, body }));
  const listRow = async (shareCode: string) => {
    const { body } = await run<SyncBody>(sync, event("/api/app/sync", { token: readToken }));
    return body.lists.find((l) => l.shareCode === shareCode)!;
  };

  it("flips a row's packed and one bag share's packed, through the editor's op path", async () => {
    const r = await post(writeToken, {
      shareCode: mine.shareCode,
      ticks: [
        { itemId: "i1", packed: true },
        { itemId: "i2", bagId: "b1", packed: true },
        { itemId: "gone-while-offline", packed: true }, // skipped by the reducer
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ version: 2 });
    const list = await listRow(mine.shareCode);
    expect(list.version).toBe(2);
    expect(list.items.find((i) => i.id === "i1")!.packed).toBe(true);
    const stake = list.items.find((i) => i.id === "i2")!;
    expect(stake.placements).toEqual([
      { bagId: "b1", qty: 2, packed: true },
      { bagId: "b2", qty: 2 },
    ]);
    // one share of two: the row isn't packed yet
    expect(stake.packed).toBeFalsy();

    // the other share too, and the row follows its shares
    expect((await post(writeToken, { shareCode: mine.shareCode, ticks: [{ itemId: "i2", bagId: "b2", packed: true }] })).body).toEqual({ version: 3 });
    expect((await listRow(mine.shareCode)).items.find((i) => i.id === "i2")!.packed).toBe(true);

    // a bare untick on the row unpacks every share
    expect((await post(writeToken, { shareCode: mine.shareCode, ticks: [{ itemId: "i2", packed: false }] })).body).toEqual({ version: 4 });
    const after = (await listRow(mine.shareCode)).items.find((i) => i.id === "i2")!;
    expect(after.packed).toBeFalsy();
    expect((after.placements as Array<{ packed?: boolean }>).every((p) => !p.packed)).toBe(true);
  });

  it("refuses a read token with 403 and no token with 401", async () => {
    const body = { shareCode: mine.shareCode, ticks: [{ itemId: "i1", packed: false }] };
    expect((await post(readToken, body)).status).toBe(403);
    expect((await post(undefined, body)).status).toBe(401);
    expect((await listRow(mine.shareCode)).items.find((i) => i.id === "i1")!.packed).toBe(true);
  });

  it("is 404 for another account's list, an unclaimed one, or a code that doesn't exist", async () => {
    const ticks = [{ itemId: "i1", packed: true }];
    expect((await post(writeToken, { shareCode: theirs.shareCode, ticks })).status).toBe(404);
    expect((await post(writeToken, { shareCode: unclaimed.shareCode, ticks })).status).toBe(404);
    expect((await post(writeToken, { shareCode: "ZZZZZZZZZZZZ", ticks })).status).toBe(404);
    // and the stranger's own token can't reach mine either
    expect((await post(strangerToken, { shareCode: mine.shareCode, ticks })).status).toBe(404);
  });

  it("is 400 for no ticks, more than 500, or a malformed tick", async () => {
    const many = Array.from({ length: 501 }, () => ({ itemId: "i1", packed: true }));
    expect((await post(writeToken, { shareCode: mine.shareCode, ticks: many })).status).toBe(400);
    expect((await post(writeToken, { shareCode: mine.shareCode, ticks: [] })).status).toBe(400);
    expect((await post(writeToken, { shareCode: mine.shareCode, ticks: [{ itemId: "i1", packed: "yes" }] })).status).toBe(400);
    expect((await post(writeToken, { shareCode: mine.shareCode, ticks: [{ itemId: "i1", bagId: 3, packed: true }] })).status).toBe(400);
    expect((await post(writeToken, { ticks: [{ itemId: "i1", packed: true }] })).status).toBe(400);
    // 500 is the ceiling, not past it
    const ok = Array.from({ length: 500 }, () => ({ itemId: "i1", packed: true }));
    expect((await post(writeToken, { shareCode: mine.shareCode, ticks: ok })).status).toBe(200);
  });
});

describe("POST /api/app/rows", () => {
  let trip = { shareCode: "", editToken: "" };
  beforeAll(async () => {
    trip = await makeList(db, "Rows", { data: DATA as never, itemCount: 2, version: 1 });
    expect(await claimLists(db as never, me, [trip.editToken])).toBe(1);
  });
  const post = (token: string | undefined, body: unknown) =>
    run<{ version: number }>(rows, event("/api/app/rows", { method: "POST", token, body }));
  const items = async () => {
    const { body } = await run<SyncBody>(sync, event("/api/app/sync", { token: readToken }));
    return body.lists.find((l) => l.shareCode === trip.shareCode)!.items;
  };

  it("drops a row and puts the very same row back, as editor ops", async () => {
    const before = (await items()).find((i) => i.id === "i2")!;
    const r = await post(writeToken, { shareCode: trip.shareCode, remove: ["i2"] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ version: 2 });
    expect((await items()).map((i) => i.id)).toEqual(["i1"]);

    const back = await post(writeToken, { shareCode: trip.shareCode, restore: [before] });
    expect(back.body).toEqual({ version: 3 });
    const again = (await items()).find((i) => i.id === "i2")!;
    expect(again.name).toBe("Stake");
    expect(again.unitWeightMg).toBe(10_000);
    expect(again.placements).toEqual(before.placements);

    // putting back a row that is already there adds nothing
    await post(writeToken, { shareCode: trip.shareCode, restore: [before] });
    expect((await items()).filter((i) => i.id === "i2")).toHaveLength(1);
  });

  it("has the packed door's rules: write token, own claimed list, sane bodies", async () => {
    const body = { shareCode: trip.shareCode, remove: ["i1"] };
    expect((await post(readToken, body)).status).toBe(403);
    expect((await post(undefined, body)).status).toBe(401);
    expect((await post(writeToken, { shareCode: theirs.shareCode, remove: ["i1"] })).status).toBe(404);
    expect((await post(writeToken, { shareCode: trip.shareCode })).status).toBe(400);
    expect((await post(writeToken, { shareCode: trip.shareCode, remove: [3] })).status).toBe(400);
    expect((await post(writeToken, { shareCode: trip.shareCode, restore: [{ name: "no id" }] })).status).toBe(400);
    expect((await post(writeToken, { shareCode: trip.shareCode, remove: Array.from({ length: 101 }, () => "x") })).status).toBe(400);
    expect((await items()).some((i) => i.id === "i1")).toBe(true);
  });
});
