import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEvent, type H3Event } from "h3";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import packed from "../server/api/app/packed.post";
import ops from "../server/api/app/ops.post";
import appItems from "../server/api/app/items.post";
import syncGet from "../server/api/app/sync.get";
import { createAccessToken } from "../server/utils/accessTokens";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { claimLists } from "../server/utils/claimRepo";
import { LISTS_DDL } from "../server/utils/db";
import { mintVault } from "../server/utils/vaultAuth";
import { captureVaultItems } from "../server/utils/vaultRepo";
import { addListMember, listMemberEmails, removeListMember } from "../server/utils/listMembers";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { CATALOG_DDL } from "../server/utils/catalog";
import { createTestDb, makeList } from "./helpers/db";

// Trip members (server/utils/listMembers.ts), end to end: an owner lets another account
// into one list; that account's app sees that list and nothing else of the owner's, the
// plan without its ownerOnly entries, and can tick and edit it; a member's setPlan can't
// reach a hidden entry; removing the member closes every door again.

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
type SyncList = { shareCode: string; role: string; items: Array<Record<string, unknown>>; plan?: { segments: Array<{ id: string }>; docs: Array<{ id: string; title: string; ownerOnly?: boolean }>; places: Array<{ id: string }> } };
type SyncBody = { lists: SyncList[]; gear: { items: Array<Record<string, unknown>> } };

let db: Db;
let owner = 0;
let ownerToken = "";
let mollyToken = "";
let mollyRead = "";
let trip = { shareCode: "", editToken: "" };
let other = { shareCode: "", editToken: "" };

const PLAN = {
  segments: [{ id: "s1", kind: "flight", title: "SFO → BKK", start: "2026-11-24T10:00:00-08:00", end: null, from: null, to: null, status: "booked", sortOrder: 0 }],
  docs: [
    { id: "d1", kind: "address", title: "Hotel", fields: [], sortOrder: 0 },
    { id: "v1", kind: "other", title: "Vlog · camera", fields: [], ownerOnly: true, sortOrder: 1 },
  ],
  places: [{ id: "p1", name: "Wat Pho", visited: false, sortOrder: 0 }],
};
const DATA = {
  folders: [{ id: "f1", name: "Meds", defaultClassification: "base" as const, sortOrder: 0 }],
  items: [{ id: "i1", folderId: "f1", name: "Advil", unitWeightMg: 0, qty: 1, classification: null, sortOrder: 0 }],
  plan: PLAN,
};

const sync = async (token: string) => (await run<SyncBody>(syncGet, event("/api/app/sync", { token }))).body;
const post = (handler: (e: H3Event) => unknown, url: string, token: string, body: unknown) =>
  run<{ version: number }>(handler, event(url, { method: "POST", token, body }));

beforeAll(async () => {
  db = await createTestDb(LISTS_DDL, ACCOUNT_DDL, VAULT_DDL, CATALOG_DDL);
  state.db = db;
  const users = await db.insert(schema.users).values([{ email: "yuwei@example.com" }, { email: "molly@example.com" }]).returning();
  owner = users[0]!.id;
  const molly = users[1]!.id;
  ownerToken = (await createAccessToken(db, owner, { scope: "write" }))!.token;
  mollyToken = (await createAccessToken(db, molly, { scope: "write" }))!.token;
  mollyRead = (await createAccessToken(db, molly, { scope: "read" }))!.token;
  trip = await makeList(db, "Bangkok", { data: DATA as never, itemCount: 1, version: 1 });
  other = await makeList(db, "Private", { data: DATA as never, itemCount: 1, version: 1 });
  expect(await claimLists(db as never, owner, [trip.editToken, other.editToken])).toBe(2);
  const vaultId = await mintVault(db as never, owner);
  await captureVaultItems(db as never, vaultId, [{ name: "Owner's quilt", weightMg: 500_000, classification: "base" } as never]);
});

describe("trip members", () => {
  it("before being added, the member's app sees nothing and every door is shut", async () => {
    expect((await sync(mollyToken)).lists).toEqual([]);
    const r = await post(packed, "/api/app/packed", mollyToken, { shareCode: trip.shareCode, ticks: [{ itemId: "i1", packed: true }] });
    expect(r.status).toBe(404);
  });

  it("only an owner adds, and only an existing account", async () => {
    expect(await addListMember(db as never, owner, trip.shareCode, "nobody@example.com")).toBe("no-account");
    expect(await addListMember(db as never, owner, trip.shareCode, "yuwei@example.com")).toBe("self");
    // Molly can't add herself, or anyone, to a list she doesn't hold
    const molly = (await db.select().from(schema.users)).find((u) => u.email === "molly@example.com")!.id;
    expect(await addListMember(db as never, molly, trip.shareCode, "molly@example.com")).toBe("not-owner");
    expect(await addListMember(db as never, owner, trip.shareCode, " Molly@Example.com ")).toBe("added");
    expect(await addListMember(db as never, owner, trip.shareCode, "molly@example.com")).toBe("already");
    expect(await listMemberEmails(db as never, owner, trip.shareCode)).toEqual(["molly@example.com"]);
    expect(await listMemberEmails(db as never, molly, trip.shareCode)).toBeNull();
  });

  it("the member's sync has that one trip, the plan without ownerOnly entries, and none of the owner's gear", async () => {
    const s = await sync(mollyRead);
    expect(s.lists.map((l) => [l.shareCode, l.role])).toEqual([[trip.shareCode, "member"]]);
    const plan = s.lists[0]!.plan!;
    expect(plan.docs.map((d) => d.id)).toEqual(["d1"]);
    expect(plan.segments.map((x) => x.id)).toEqual(["s1"]);
    expect(s.gear.items).toEqual([]);
    // the owner still sees everything, as owner
    const mine = await sync(ownerToken);
    expect(mine.lists.every((l) => l.role === "owner")).toBe(true);
    expect(mine.lists.find((l) => l.shareCode === trip.shareCode)!.plan!.docs.map((d) => d.id)).toEqual(["d1", "v1"]);
  });

  it("the member ticks and edits the trip, but not the owner's other list", async () => {
    const t = await post(packed, "/api/app/packed", mollyToken, { shareCode: trip.shareCode, ticks: [{ itemId: "i1", packed: true }] });
    expect(t.status).toBe(200);
    const a = await post(appItems, "/api/app/items", mollyToken, { shareCode: trip.shareCode, add: [{ id: "m1", name: "Molly's charger" }] });
    expect(a.status).toBe(200);
    const row = (await sync(ownerToken)).lists.find((l) => l.shareCode === trip.shareCode)!.items;
    expect(row.find((i) => i.id === "i1")!.packed).toBe(true);
    expect(row.some((i) => i.id === "m1")).toBe(true);
    const o = await post(packed, "/api/app/packed", mollyToken, { shareCode: other.shareCode, ticks: [{ itemId: "i1", packed: true }] });
    expect(o.status).toBe(404);
    // a read token is still a read token
    expect((await post(packed, "/api/app/packed", mollyRead, { shareCode: trip.shareCode, ticks: [{ itemId: "i1", packed: false }] })).status).toBe(403);
  });

  it("a member's setPlan can't overwrite, clear or reveal an ownerOnly entry", async () => {
    const send = (plan: unknown) => post(ops, "/api/app/ops", mollyToken, { shareCode: trip.shareCode, ops: [{ t: "setPlan", plan }] });
    // replace the whole plan with one doc, try to overwrite the hidden one, and mark one hidden
    const r = await send({
      segments: [],
      docs: [
        { id: "d2", kind: "other", title: "Molly SIM", fields: [], ownerOnly: true, sortOrder: 0 },
        { id: "v1", kind: "other", title: "hijacked", fields: [], sortOrder: 1 },
      ],
      places: [],
    });
    expect(r.status).toBe(200);
    const owners = (await sync(ownerToken)).lists.find((l) => l.shareCode === trip.shareCode)!.plan!;
    expect(owners.docs.map((d) => [d.id, d.title, d.ownerOnly ?? false])).toEqual([
      ["d2", "Molly SIM", false],
      ["v1", "Vlog · camera", true],
    ]);
    await send(null);
    const cleared = (await sync(ownerToken)).lists.find((l) => l.shareCode === trip.shareCode)!.plan!;
    expect(cleared.docs.map((d) => d.id)).toEqual(["v1"]);
    expect((await sync(mollyToken)).lists[0]!.plan).toBeUndefined();
  });

  it("a checklist step ticks on its own; a member can't tick an ownerOnly doc", async () => {
    const owner_ops = (body: unknown[]) => post(ops, "/api/app/ops", ownerToken, { shareCode: trip.shareCode, ops: body });
    await owner_ops([{ t: "setPlan", plan: { segments: [], places: [], docs: [
      { id: "c1", kind: "checklist", title: "Shared", fields: [], steps: [{ id: "x", label: "Passports" }], sortOrder: 0 },
      { id: "c2", kind: "checklist", title: "Vlog", fields: [], steps: [{ id: "y", label: "ND" }], ownerOnly: true, sortOrder: 1 },
    ] } }]);
    const tick = (docId: string, stepId: string) => post(ops, "/api/app/ops", mollyToken, { shareCode: trip.shareCode, ops: [{ t: "checkPlanStep", docId, stepId, done: true }] });
    expect((await tick("c1", "x")).status).toBe(200);
    expect((await tick("c2", "y")).status).toBe(200);
    const docs = (await sync(ownerToken)).lists.find((l) => l.shareCode === trip.shareCode)!.plan!.docs as unknown as Array<{ id: string; steps: Array<{ done: boolean }> }>;
    expect(docs.map((d) => [d.id, d.steps[0]!.done])).toEqual([["c1", true], ["c2", false]]);
  });

  it("removing the member closes every door again", async () => {
    expect(await removeListMember(db as never, owner, trip.shareCode, "molly@example.com")).toBe(true);
    expect(await removeListMember(db as never, owner, trip.shareCode, "molly@example.com")).toBe(false);
    expect((await sync(mollyToken)).lists).toEqual([]);
    const r = await post(packed, "/api/app/packed", mollyToken, { shareCode: trip.shareCode, ticks: [{ itemId: "i1", packed: false }] });
    expect(r.status).toBe(404);
  });
});
