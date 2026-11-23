import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEvent, type H3Event } from "h3";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import mcp from "../server/routes/mcp.post";
import sync from "../server/api/app/sync.get";
import { createAccessToken } from "../server/utils/accessTokens";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { claimLists } from "../server/utils/claimRepo";
import { CATALOG_DDL } from "../server/utils/catalog";
import { LISTS_DDL, SNAPSHOTS_DDL, TRAIL_FAVICONS_DDL, _resetSnapshotEnsured } from "../server/utils/db";
import { applyOpsByEditHash, getByShareCode } from "../server/utils/listRepo";
import { applyListDiff, diffListState, fullSnapToState, stateToFullSnap } from "../shared/snapshotDiff";
import { sha256Hex } from "../server/utils/tokens";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { normalizePlan } from "../shared/plan";
import { createTestDb, makeList } from "./helpers/db";
import { expectResultConforms } from "./helpers/mcpSchema";

// The trip plan: written over the connector with the edit link, read back by the
// owner's app through sync, and never on a share link.

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
vi.stubEnv("DATABASE_URL", "");

function event(url: string, { method = "GET", token, body }: { method?: string; token?: string; body?: unknown } = {}): H3Event {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = url;
  const buf = body === undefined ? null : Buffer.from(JSON.stringify(body));
  req.headers = {
    host: "mahonia.test",
    ...(buf ? { "content-type": "application/json", "content-length": String(buf.length), accept: "application/json, text/event-stream" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  if (buf) req.push(buf);
  req.push(null);
  return createEvent(req, new ServerResponse(req));
}
const call = async (name: string, args: unknown) => {
  const out = (await mcp(event("/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } }))) as {
    result: { structuredContent?: Record<string, unknown>; content: { text: string }[]; isError?: boolean };
  };
  expectResultConforms(name, out.result);
  return { data: out.result.structuredContent as Record<string, unknown>, text: out.result.content[0]!.text, isError: out.result.isError ?? false };
};

let editLink = "";
let editToken = "";
let shareCode = "";
let token = "";

beforeAll(async () => {
  const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL, TRAIL_FAVICONS_DDL, CATALOG_DDL, ACCOUNT_DDL, VAULT_DDL);
  _resetSnapshotEnsured();
  state.db = db;
  const [me] = await db.insert(schema.users).values([{ email: "me@example.com" }]).returning();
  token = (await createAccessToken(db, me!.id, { scope: "read" }))!.token;
  const list = await makeList(db, "Bangkok", {
    data: { folders: [], items: [{ id: "i1", folderId: null, name: "Passport wallet", unitWeightMg: 0, qty: 1, classification: null, sortOrder: 0 }] } as never,
  });
  editToken = list.editToken;
  shareCode = list.shareCode;
  editLink = `https://mahonia.test/e/${shareCode}#${editToken}`;
  expect(await claimLists(db as never, me!.id, [editToken])).toBe(1);
});

describe("normalizePlan", () => {
  it("drops what isn't a plan entry and keeps the contract's field names", () => {
    const plan = normalizePlan({
      segments: [
        { id: "s1", kind: "flight", title: "LAX → ICN", start: "2026-11-22T09:00:00-08:00", end: "2026-11-23T15:30:00+09:00", startTz: "America/Los_Angeles", from: { code: "LAX" }, to: { code: "ICN", name: "Incheon" }, carrier: "Asiana", number: "OZ203", seats: [{ person: "Yuwei", seat: "31A" }, { person: "", seat: "31B" }], status: "booked", sortOrder: 0 },
        { id: "s2", kind: "flight", title: "no start" },
        { id: "s1", kind: "stay", title: "duplicate id", start: "2026-11-23T20:00:00+07:00" },
      ],
      docs: [{ id: "d1", kind: "address", title: "Hotel", lang: "th", fields: [{ label: "地址", value: "ถนนสุขุมวิท", copy: true }], qr: "https://example.com" }],
      places: [{ id: "p1", name: "Wat Pho", lat: 13.74, lng: 100.49, photoUrl: "javascript:alert(1)" }, { id: "p2" }],
    })!;
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]).toMatchObject({ end: "2026-11-23T15:30:00+09:00", from: { code: "LAX" }, seats: [{ person: "Yuwei", seat: "31A" }] });
    expect(plan.docs[0]!.fields).toEqual([{ label: "地址", value: "ถนนสุขุมวิท", copy: true }]);
    expect(plan.places).toEqual([{ id: "p1", name: "Wat Pho", lat: 13.74, lng: 100.49, visited: false, sortOrder: 0 }]);
  });
  it("an empty plan is no plan", () => {
    expect(normalizePlan({ segments: [], docs: [], places: [] })).toBeUndefined();
    expect(normalizePlan("junk")).toBeUndefined();
  });
});

describe("the plan over the connector", () => {
  it("makes entries without ids and says which ids they got", async () => {
    const { data, isError, text } = await call("set_plan", {
      edit_link: editLink,
      segments: [{ kind: "flight", title: "LAX → ICN", start: "2026-11-22T09:00:00-08:00", end: null, from: { code: "LAX" }, to: { code: "ICN" }, status: "booked", confirmation: "ABC123" }],
      docs: [{ kind: "entry", title: "TDAC", person: "Yuwei", fields: [{ label: "No.", value: "TDAC-1", copy: true }], qr: "TDAC-1" }],
      places: [{ name: "Wat Pho", visited: false }],
    });
    expect(isError, text).toBe(false);
    const created = data.created as { list: string; id: string }[];
    expect(created.map((c) => c.list)).toEqual(["segments", "docs", "places"]);
    const plan = data.plan as { segments: { id: string; confirmation: string }[] };
    expect(plan.segments[0]!.id).toBe(created[0]!.id);
    expect(plan.segments[0]!.confirmation).toBe("ABC123");
  });

  it("updates an entry in only the fields given; null clears an optional one", async () => {
    const before = (await call("get_plan", { edit_link: editLink })).data.plan as { places: { id: string }[]; segments: { id: string }[] };
    const { data } = await call("set_plan", {
      edit_link: editLink,
      places: [{ id: before.places[0]!.id, visited: true }],
      segments: [{ id: before.segments[0]!.id, confirmation: null, seats: [{ person: "Molly", seat: "31B" }] }],
    });
    const plan = data.plan as { places: { visited: boolean; name: string }[]; segments: Record<string, unknown>[] };
    expect(plan.places[0]).toMatchObject({ name: "Wat Pho", visited: true });
    expect(plan.segments[0]!.confirmation).toBeUndefined();
    expect(plan.segments[0]!.seats).toEqual([{ person: "Molly", seat: "31B" }]);
    expect(plan.segments[0]!.title).toBe("LAX → ICN");
  });

  it("refuses a new segment with no start, and wants an edit link to read", async () => {
    const bad = await call("set_plan", { edit_link: editLink, segments: [{ kind: "ground", title: "taxi" }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("start");
    const byShare = await call("get_plan", { edit_link: shareCode });
    expect(byShare.isError).toBe(true);
  });

  it("is never on the share-code read", async () => {
    const snap = await getByShareCode(shareCode);
    expect(snap!.plan).toBeUndefined();
    const read = await call("get_list", { share_code: shareCode });
    expect(JSON.stringify(read.data)).not.toContain("TDAC");
  });

  it("rides the owner's app sync", async () => {
    const body = (await sync(event("/api/app/sync", { token }))) as unknown as { lists: { shareCode: string; plan?: { segments: unknown[]; docs: unknown[]; places: unknown[] } }[] };
    const list = body.lists.find((l) => l.shareCode === shareCode)!;
    expect(list.plan!.segments).toHaveLength(1);
    expect(list.plan!.docs).toHaveLength(1);
    expect(list.plan!.places).toHaveLength(1);
  });

  it("survives an unrelated edit, and remove_plan_items reports unknown ids", async () => {
    const hash = sha256Hex(editToken);
    await applyOpsByEditHash(hash, [{ t: "updateItem", id: "i1", patch: { name: "Wallet" } }]);
    const plan = (await call("get_plan", { edit_link: editLink })).data.plan as { docs: { id: string }[] };
    expect(plan.docs).toHaveLength(1);
    const removed = await call("remove_plan_items", { edit_link: editLink, ids: [plan.docs[0]!.id, "nope"] });
    expect((removed.data.plan as { docs: unknown[] }).docs).toHaveLength(0);
    expect(removed.data.missing).toEqual(["nope"]);
  });

  it("a recovery point carries the plan: the full form and the reverse delta", () => {
    const plan = normalizePlan({ places: [{ id: "p1", name: "Wat Pho" }] })!;
    const base = { title: "t", displayUnit: "g" as const, folders: [], items: [], version: 1 };
    const withPlan = { ...base, plan };
    expect(fullSnapToState(stateToFullSnap(withPlan)).plan).toEqual(plan);
    // newer has no plan; the delta back to the older state must bring it back, and vice versa
    expect(applyListDiff(structuredClone(base), diffListState(base, withPlan)).plan).toEqual(plan);
    expect(applyListDiff(structuredClone(withPlan), diffListState(withPlan, base)).plan).toBeUndefined();
  });

  it("a list with no plan leaves the key out of sync", async () => {
    const db = state.db as Awaited<ReturnType<typeof createTestDb>>;
    const other = await makeList(db, "Plain");
    const [u] = await db.select().from(schema.users).limit(1);
    await claimLists(db as never, u!.id, [other.editToken]);
    const body = (await sync(event("/api/app/sync", { token }))) as unknown as { lists: Record<string, unknown>[] };
    expect("plan" in body.lists.find((l) => l.shareCode === other.shareCode)!).toBe(false);
  });
});

describe("article and checklist docs", () => {
  it("an article keeps its markdown as written; a checklist's steps get ids and ticks", () => {
    const plan = normalizePlan({
      docs: [
        { id: "a1", kind: "article", title: "Camera guide", body: "# Setup\r\n\n- step one\n    indented code\n", images: [{ url: "https://example.com/a.jpg", caption: "dial" }, { url: "javascript:x" }] },
        { id: "c1", kind: "checklist", title: "On the plane", steps: [{ label: "Format card", path: "MENU › Setup", value: "Format", why: "fresh\nstart" }, { id: "s2", label: "ND filter", done: true }, { label: "" }] },
      ],
    })!;
    const [a, c] = plan.docs;
    expect(a!.body).toBe("# Setup\n\n- step one\n    indented code");
    expect(a!.images).toEqual([{ url: "https://example.com/a.jpg", caption: "dial" }]);
    expect(c!.steps).toEqual([
      { id: "step-1", label: "Format card", path: "MENU › Setup", value: "Format", why: "fresh\nstart", done: false },
      { id: "s2", label: "ND filter", done: true },
    ]);
  });
});
