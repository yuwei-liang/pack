import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEvent } from "h3";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import mcp from "../server/routes/mcp.post";
import { createAccessToken } from "../server/utils/accessTokens";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { CATALOG_DDL } from "../server/utils/catalog";
import { claimLists } from "../server/utils/claimRepo";
import { LISTS_DDL } from "../server/utils/db";
import { getByShareCode, getPlanByEditHash } from "../server/utils/listRepo";
import { sha256Hex } from "../server/utils/tokens";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { createTestDb, makeList } from "./helpers/db";
import { expectResultConforms } from "./helpers/mcpSchema";

// A token is its owner on the lists its account has claimed: the list tools take a
// share code in place of an edit link there (listHashFor), write tools want a write
// token, and nobody else's list opens that way. The edit link keeps working as before.

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

async function call(name: string, args: unknown, token?: string) {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.url = "/mcp";
  const buf = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));
  req.headers = {
    host: "mahonia.test",
    "content-type": "application/json",
    "content-length": String(buf.length),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  req.push(buf);
  req.push(null);
  const out = (await mcp(createEvent(req, new ServerResponse(req)))) as {
    result: { structuredContent?: Record<string, unknown>; content: { text: string }[]; isError?: boolean };
  };
  expectResultConforms(name, out.result);
  return { data: out.result.structuredContent as Record<string, unknown>, text: out.result.content[0]!.text, isError: out.result.isError ?? false };
}

const DATA = {
  folders: [{ id: "f1", name: "Shelter", defaultClassification: "base" as const, sortOrder: 0 }],
  items: [{ id: "i1", folderId: "f1", name: "Duplex", unitWeightMg: 538_000, qty: 1, classification: null, sortOrder: 0 }],
  bags: [{ id: "b1", name: "Cabin", kind: "carry-on", sortOrder: 0 }],
};

type Db = Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let readToken = "";
let writeToken = "";
let strangerToken = "";
let mine = { shareCode: "", editToken: "" };
let theirs = { shareCode: "", editToken: "" };
let unclaimed = { shareCode: "", editToken: "" };

beforeAll(async () => {
  db = await createTestDb(LISTS_DDL, ACCOUNT_DDL, VAULT_DDL, CATALOG_DDL);
  state.db = db;
  const [me, stranger] = (
    await db.insert(schema.users).values([{ email: "me@example.com" }, { email: "them@example.com" }]).returning()
  ).map((u) => u.id);
  readToken = (await createAccessToken(db, me!, { scope: "read" }))!.token;
  writeToken = (await createAccessToken(db, me!, { scope: "write" }))!.token;
  strangerToken = (await createAccessToken(db, stranger!, { scope: "write" }))!.token;
  mine = await makeList(db, "Kyoto", { data: DATA as never, itemCount: 1, version: 1 });
  theirs = await makeList(db, "Theirs", { data: DATA as never, itemCount: 1, version: 1 });
  unclaimed = await makeList(db, "Nobody's", { data: DATA as never, itemCount: 1, version: 1 });
  expect(await claimLists(db as never, me!, [mine.editToken])).toBe(1);
  expect(await claimLists(db as never, stranger!, [theirs.editToken])).toBe(1);
});

const DOC = { kind: "other", title: "Hotel wifi", fields: [{ label: "Network", value: "Ryokan-5G", copy: true }], note: "Front desk resets it daily" };

describe("list tools by share code, as the list's owner", () => {
  it("list_my_lists names the account's claimed lists, with a read token", async () => {
    const r = await call("list_my_lists", {}, readToken);
    expect(r.isError, r.text).toBe(false);
    const lists = r.data.lists as Array<Record<string, unknown>>;
    expect(lists.map((l) => l.share_code)).toEqual([mine.shareCode]);
    expect(lists[0]).toMatchObject({ title: "Kyoto", item_count: 1, version: 1, share_link: `http://mahonia.test/s/${mine.shareCode}` });
    expect(JSON.stringify(r.data)).not.toContain(mine.editToken);
    expect((await call("list_my_lists", {})).isError).toBe(true);
  });

  it("set_plan and add_items work on the own claimed list with a write token", async () => {
    const plan = await call("set_plan", { share_code: mine.shareCode, docs: [DOC] }, writeToken);
    expect(plan.isError, plan.text).toBe(false);
    const docs = (plan.data.plan as { docs: Array<Record<string, unknown>> }).docs;
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject(DOC);
    expect(await getPlanByEditHash(sha256Hex(mine.editToken))).toMatchObject({ docs: [DOC] });

    // a share link works as well as the bare code, and a row can name its bag
    const add = await call("add_items", { share_code: `http://mahonia.test/s/${mine.shareCode}`, items: [{ name: "Headlamp", weight_g: 50, qty: 2, bag: "cabin" }] }, writeToken);
    expect(add.isError, add.text).toBe(false);
    expect(add.data.added).toBe(1);
    const snap = (await getByShareCode(mine.shareCode))!;
    const lamp = snap.items.find((i) => i.name === "Headlamp")!;
    expect(lamp.placements).toEqual([{ bagId: "b1", qty: 2 }]);

    // a read token is enough for the plan's read
    const read = await call("get_plan", { share_code: mine.shareCode }, readToken);
    expect(read.isError, read.text).toBe(false);
    expect((read.data.plan as { docs: unknown[] }).docs).toHaveLength(1);
  });

  it("refuses a read token on a write tool, and changes nothing", async () => {
    const before = (await getByShareCode(mine.shareCode))!.version;
    const r = await call("add_items", { share_code: mine.shareCode, items: [{ name: "Nope" }] }, readToken);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("only read");
    expect((await call("set_plan", { share_code: mine.shareCode, docs: [DOC] }, readToken)).isError).toBe(true);
    expect((await getByShareCode(mine.shareCode))!.version).toBe(before);
  });

  it("refuses another account's list, an unclaimed one, and a share code with no token", async () => {
    for (const [code, token] of [[theirs.shareCode, writeToken], [unclaimed.shareCode, writeToken], [mine.shareCode, strangerToken], [mine.shareCode, undefined]] as const) {
      const r = await call("set_plan", { share_code: code, docs: [DOC] }, token);
      expect(r.isError, `${code} ${token}`).toBe(true);
    }
    expect((await call("add_items", { share_code: theirs.shareCode, items: [{ name: "Nope" }] }, writeToken)).text).toContain("isn't saved to this connector's account");
    expect(await getPlanByEditHash(sha256Hex(theirs.editToken))).toBeUndefined();
  });

  it("wants exactly one of edit_link and share_code", async () => {
    const both = await call("set_trip", { edit_link: `http://mahonia.test/e/${mine.shareCode}#${mine.editToken}`, share_code: mine.shareCode, title: "x" }, writeToken);
    expect(both.isError).toBe(true);
    expect(both.text).toContain("edit_link or share_code");
    const neither = await call("set_trip", { title: "x" }, writeToken);
    expect(neither.isError).toBe(true);
    expect(neither.text).toContain("share_code");
  });

  it("leaves the edit-link path as it was, with or without a token", async () => {
    const link = `http://mahonia.test/e/${unclaimed.shareCode}#${unclaimed.editToken}`;
    const r = await call("add_items", { edit_link: link, items: [{ name: "Spoon", bag: "Cabin" }] });
    expect(r.isError, r.text).toBe(false);
    const t = await call("set_trip", { edit_link: link, title: "Renamed" }, readToken);
    expect(t.isError, t.text).toBe(false);
    expect(t.data.title).toBe("Renamed");
    // a share code passed as the edit link still opens nothing
    expect((await call("get_plan", { edit_link: mine.shareCode }, writeToken)).isError).toBe(true);
  });

  it("names the bags a row can go in when it names one the list lacks", async () => {
    const r = await call("add_items", { share_code: mine.shareCode, items: [{ name: "Cup", bag: "Hip pack" }] }, writeToken);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Cabin");
  });
});
