import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEvent } from "h3";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import mcp from "../server/routes/mcp.post";
import { createAccessToken } from "../server/utils/accessTokens";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { listClaimedLists } from "../server/utils/claimRepo";
import { LISTS_DDL } from "../server/utils/db";
import { rateLimitSubject } from "../server/utils/rateLimit";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { setKitParts } from "../server/utils/vaultRepo";
import { createTestDb } from "./helpers/db";
import { expectResultConforms } from "./helpers/mcpSchema";

// Kits over MCP (docs/design/my-gear-kits.md §7): every gear row grows kind,
// own_weight_g, parts and in_kits, and a kit's weight_g is its derived total, so an
// old client that reads weight_g alone still gets the true figure. Additive only.
// The one write it guards: weight_g on a kit is refused, since writing a total into
// the kit's own weight would count every part twice.

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../server/utils/db", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../server/utils/db")>();
  const grab = async () => state.db;
  return { ...mod, useDb: grab, useCatalogDb: grab, useVaultDb: grab, useAccountDb: grab };
});
vi.mock("../server/utils/rateLimit", () => ({
  rateLimit: async () => {},
  rateLimitSubject: vi.fn(async () => {}),
  useKv: () => ({ getItem: async () => null, setItem: async () => {} }),
}));

type Result = { structuredContent?: Record<string, unknown>; content: { text: string }[]; isError?: boolean };

async function rpc(method: string, params: unknown, token?: string) {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.url = "/mcp";
  const buf = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  req.headers = {
    host: "mahonia.test",
    "content-type": "application/json",
    "content-length": String(buf.length),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  req.push(buf);
  req.push(null);
  const event = createEvent(req, new ServerResponse(req));
  const out = (await mcp(event)) as { result?: Result };
  return { status: event.node.res.statusCode, result: out.result! };
}
const call = async (name: string, args: unknown, token?: string) => {
  const { status, result } = await rpc("tools/call", { name, arguments: args }, token);
  expectResultConforms(name, result);
  return { status, data: result.structuredContent as Record<string, unknown>, text: result.content[0]!.text, isError: result.isError ?? false };
};

type Db = Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let token = "";
let vaultId = 0;
const ids: Record<string, number> = {};

beforeAll(async () => {
  db = await createTestDb(LISTS_DDL, ACCOUNT_DDL, VAULT_DDL);
  state.db = db;
  const [me] = await db.insert(schema.users).values({ email: "kits@example.com" }).returning();
  token = (await createAccessToken(db, me!.id, { scope: "write" }))!.token;
  const r = await call(
    "add_my_gear",
    {
      items: [
        { name: "X-S20 body", weight_g: 424, folder: "Photo" },
        { name: "NP-W235", weight_g: 81, folder: "Photo" },
        { name: "XF 16-55 II", weight_g: 453, folder: "Photo" },
        { name: "Camera kit", weight_g: 958, folder: "Photo · kits" },
      ],
    },
    token,
  );
  expect(r.isError, r.text).toBe(false);
  for (const res of r.data.results as { item: { id: number; name: string } }[]) ids[res.item.name] = res.item.id;
  vaultId = (await db.select().from(schema.vaults))[0]!.id;
  const made = await setKitParts(
    db,
    vaultId,
    ids["Camera kit"]!,
    [{ id: ids["X-S20 body"]! }, { id: ids["NP-W235"]!, qty: 2 }, { id: ids["XF 16-55 II"]! }],
    { ownWeightMg: 0 },
  );
  expect(made).toBe(true);
});

type Gear = Record<string, unknown> & { id: number; name: string };
const gear = async () => (await call("list_my_gear", {}, token)).data.gear as Gear[];

describe("kits over MCP", () => {
  it("describes a kit with its parts and its derived weight_g", async () => {
    const kit = (await gear()).find((g) => g.id === ids["Camera kit"])!;
    expect(kit).toMatchObject({ kind: "kit", own_weight_g: 0, weight_g: 424 + 2 * 81 + 453, in_kits: [] });
    expect(kit.parts).toEqual([
      { id: ids["X-S20 body"], display_name: "X-S20 body", qty: 1, weight_g: 424, removed: false },
      { id: ids["NP-W235"], display_name: "NP-W235", qty: 2, weight_g: 81, removed: false },
      { id: ids["XF 16-55 II"], display_name: "XF 16-55 II", qty: 1, weight_g: 453, removed: false },
    ]);
  });

  it("tells a piece which kits it's in, and a piece in none that it's in none", async () => {
    await call("add_my_gear", { items: [{ name: "Spare strap", weight_g: 30 }] }, token);
    const rows = await gear();
    expect(rows.find((g) => g.id === ids["NP-W235"])).toMatchObject({
      kind: "piece",
      own_weight_g: null,
      parts: [],
      in_kits: [{ id: ids["Camera kit"], display_name: "Camera kit" }],
    });
    expect(rows.find((g) => g.name === "Spare strap")).toMatchObject({ kind: "piece", in_kits: [] });
    // a search result names its kits too, though the kit isn't among the hits
    const found = (await call("list_my_gear", { query: "NP-W235" }, token)).data.gear as Gear[];
    expect(found[0]).toMatchObject({ in_kits: [{ id: ids["Camera kit"], display_name: "Camera kit" }] });
  });

  it("refuses weight_g on a kit and changes nothing, but takes a rename", async () => {
    const r = await call("update_my_gear", { id: ids["Camera kit"], weight_g: 1200, name: "Photo kit" }, token);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/kit/);
    const kit = (await gear()).find((g) => g.id === ids["Camera kit"])!;
    expect(kit).toMatchObject({ name: "Camera kit", own_weight_g: 0, weight_g: 1039 });
    const renamed = await call("update_my_gear", { id: ids["Camera kit"], name: "Photo kit" }, token);
    expect(renamed.isError, renamed.text).toBe(false);
    expect(renamed.data.item).toMatchObject({ name: "Photo kit", kind: "kit", weight_g: 1039 });
  });

  it("removing a part says which kits got lighter, and the kit stops counting it", async () => {
    const r = await call("remove_my_gear", { id: ids["XF 16-55 II"] }, token);
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toEqual({ id: ids["XF 16-55 II"], status: "removed", in_kits: [{ id: ids["Camera kit"], display_name: "Photo kit" }] });
    const kit = (await gear()).find((g) => g.id === ids["Camera kit"])!;
    expect(kit.weight_g).toBe(424 + 2 * 81);
    expect((kit.parts as { id: number; removed: boolean }[]).find((p) => p.id === ids["XF 16-55 II"])!.removed).toBe(true);
    await call("remove_my_gear", { id: ids["XF 16-55 II"], restore: true }, token);
    expect((await gear()).find((g) => g.id === ids["Camera kit"])!.weight_g).toBe(1039);
  });
});

describe("set_kit_parts", () => {
  it("makes a typed-in kit row a kit of pieces, its own weight beside the parts", async () => {
    const add = await call(
      "add_my_gear",
      { items: [{ name: "Rig kit", weight_g: 600 }, { name: "Cage", weight_g: 120 }, { name: "Plate", weight_g: 40 }] },
      token,
    );
    for (const res of add.data.results as { item: { id: number; name: string } }[]) ids[res.item.name] = res.item.id;
    const r = await call(
      "set_kit_parts",
      { id: ids["Rig kit"], parts: [{ id: ids["Cage"] }, { id: ids["Plate"], qty: 2 }], own_weight_g: 15 },
      token,
    );
    expect(r.isError, r.text).toBe(false);
    expect(r.data.item).toMatchObject({ kind: "kit", own_weight_g: 15, weight_g: 15 + 120 + 2 * 40 });
    expect((await gear()).find((g) => g.id === ids["Plate"])).toMatchObject({
      in_kits: [{ id: ids["Rig kit"], display_name: "Rig kit" }],
    });
  });

  it("replaces the parts whole", async () => {
    const r = await call("set_kit_parts", { id: ids["Rig kit"], parts: [{ id: ids["Cage"] }] }, token);
    expect(r.isError, r.text).toBe(false);
    expect(r.data.item).toMatchObject({ own_weight_g: 0, weight_g: 120 });
    expect((await gear()).find((g) => g.id === ids["Plate"])).toMatchObject({ in_kits: [] });
  });

  it("refuses a kit as a part, a kit inside a kit, and an unknown id — changing nothing", async () => {
    for (const parts of [[{ id: ids["Camera kit"] }], [{ id: ids["Rig kit"] }], [{ id: 999_999 }]]) {
      const r = await call("set_kit_parts", { id: ids["Rig kit"], parts }, token);
      expect(r.isError).toBe(true);
    }
    // a part of a kit can't become a kit itself
    const r = await call("set_kit_parts", { id: ids["NP-W235"], parts: [{ id: ids["Plate"] }] }, token);
    expect(r.isError).toBe(true);
    expect((await gear()).find((g) => g.id === ids["Rig kit"])).toMatchObject({ kind: "kit", weight_g: 120 });
  });

  it("turns a kit back into a piece that keeps its total, and frees its parts", async () => {
    const r = await call("set_kit_parts", { id: ids["Rig kit"], parts: [] }, token);
    expect(r.isError, r.text).toBe(false);
    expect(r.data.item).toMatchObject({ kind: "piece", weight_g: 120, parts: [] });
    expect((await gear()).find((g) => g.id === ids["Cage"])).toMatchObject({ in_kits: [] });
    // and an empty parts list on a piece is refused
    expect((await call("set_kit_parts", { id: ids["Rig kit"], parts: [] }, token)).isError).toBe(true);
  });
});
