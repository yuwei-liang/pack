import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEvent } from "h3";
import { beforeAll, describe, expect, it, vi } from "vitest";
import mcp from "../server/routes/mcp.post";
import { CATALOG_DDL } from "../server/utils/catalog";
import { LISTS_DDL, SNAPSHOTS_DDL, TRAIL_FAVICONS_DDL, _resetSnapshotEnsured } from "../server/utils/db";
import { createTestDb } from "./helpers/db";
import { stubFetch } from "./helpers/http";
import { expectResultConforms } from "./helpers/mcpSchema";

// An assistant packing a trip into bags over the connector: make the bags, point one
// at its own row, split a row between two, and read the weights back.

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../server/utils/db", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../server/utils/db")>();
  const grab = async () => state.db;
  return { ...mod, useDb: grab, useCatalogDb: grab, useVaultDb: grab, useAccountDb: grab };
});
vi.mock("../server/utils/rateLimit", () => {
  const kv = new Map<string, unknown>();
  return {
    rateLimit: async () => {},
    rateLimitSubject: async () => {},
    useKv: () => ({ getItem: async (k: string) => kv.get(k) ?? null, setItem: async (k: string, v: unknown) => void kv.set(k, v) }),
  };
});
vi.stubEnv("DATABASE_URL", "");

async function rpc(method: string, params?: unknown, id = 1) {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.url = "/mcp";
  const buf = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  req.headers = { host: "mahonia.test", "content-type": "application/json", "content-length": String(buf.length) };
  req.push(buf);
  req.push(null);
  const out = (await mcp(createEvent(req, new ServerResponse(req)))) as { result?: { structuredContent?: Record<string, unknown>; content: { text: string }[]; isError?: boolean } };
  return out.result!;
}
const call = async (name: string, args: unknown) => {
  const r = await rpc("tools/call", { name, arguments: args });
  expectResultConforms(name, r);
  return { data: r.structuredContent as Record<string, unknown>, text: r.content[0]!.text, isError: r.isError ?? false };
};

type Row = { id: string; name: string; in_bags?: { bag: string; qty: number }[]; is_bag?: string };
const rows = (list: Record<string, unknown>) =>
  (list.folders as { items: Row[] }[]).flatMap((f) => f.items);

let editLink = "";
let shareCode = "";

beforeAll(async () => {
  stubFetch(() => null);
  const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL, TRAIL_FAVICONS_DDL, CATALOG_DDL);
  _resetSnapshotEnsured();
  state.db = db;
  const { data } = await call("create_list", {
    title: "Bangkok",
    folders: [
      { name: "衣物", items: [{ name: "T 恤", qty: 4, weight_g: 150 }, { name: "外套", weight_g: 360 }] },
      { name: "电力", items: [{ name: "INIU 20K 充电宝", weight_g: 312 }] },
      { name: "背包", items: [{ name: "MUJI 登机箱", weight_g: 3100 }] },
    ],
  });
  editLink = data.edit_link as string;
  shareCode = data.share_code as string;
});

describe("packing into bags over the connector", () => {
  it("makes bags, one pointed at its own row", async () => {
    const list = (await call("get_list", { share_code: shareCode })).data;
    const roller = rows(list).find((r) => r.name === "MUJI 登机箱")!;
    const { data, isError, text } = await call("set_bags", {
      edit_link: editLink,
      bags: [
        { name: "MUJI 登机箱", kind: "carry-on", row_id: roller.id, limit_kg: 3.3 },
        { name: "28 寸托运箱", kind: "checked", limit_kg: 23 },
      ],
    });
    expect(isError, text).toBe(false);
    expect((data.bags as { name: string; empty_g: number }[]).map((b) => [b.name, b.empty_g])).toEqual([
      ["MUJI 登机箱", 3100],
      ["28 寸托运箱", 0],
    ]);
  });

  it("splits a row between bags and reports the weights against the limits", async () => {
    const list = (await call("get_list", { share_code: shareCode })).data;
    const byName = new Map(rows(list).map((r) => [r.name, r.id]));
    const { data, isError, text } = await call("pack_items", {
      edit_link: editLink,
      items: [
        { id: byName.get("T 恤"), bags: [{ bag: "muji 登机箱", qty: 2 }, { bag: "28 寸托运箱", qty: 2 }] },
        { id: byName.get("INIU 20K 充电宝"), bags: [{ bag: "MUJI 登机箱" }] },
      ],
    });
    expect(isError, text).toBe(false);
    const [cabin, big] = data.bags as { total_g: number; over: boolean; rows: number }[];
    expect(cabin).toMatchObject({ total_g: 3100 + 300 + 312, over: true, rows: 2 });
    expect(big).toMatchObject({ total_g: 300, over: false, rows: 1 });
    expect(data.unpacked_rows).toBe(1); // the jacket
  });

  it("get_list says where each row travels", async () => {
    const list = (await call("get_list", { share_code: shareCode })).data;
    const r = new Map(rows(list).map((x) => [x.name, x]));
    expect(r.get("T 恤")!.in_bags).toEqual([{ bag: "MUJI 登机箱", qty: 2 }, { bag: "28 寸托运箱", qty: 2 }]);
    expect(r.get("MUJI 登机箱")!.is_bag).toBe("MUJI 登机箱");
    expect(r.get("外套")!.in_bags).toBeUndefined();
    expect(list.unpacked_rows).toBe(1);
  });

  it("refuses a split past the row's qty, an unknown bag, and a bag inside itself", async () => {
    const list = (await call("get_list", { share_code: shareCode })).data;
    const byName = new Map(rows(list).map((r) => [r.name, r.id]));
    const over = await call("pack_items", { edit_link: editLink, items: [{ id: byName.get("T 恤"), bags: [{ bag: "MUJI 登机箱", qty: 3 }, { bag: "28 寸托运箱", qty: 3 }] }] });
    expect(over.isError).toBe(true);
    expect(over.text).toContain("qty 4");
    const ghost = await call("pack_items", { edit_link: editLink, items: [{ id: byName.get("外套"), bags: [{ bag: "Duffel" }] }] });
    expect(ghost.text).toContain("28 寸托运箱");
    const self = await call("pack_items", { edit_link: editLink, items: [{ id: byName.get("MUJI 登机箱"), bags: [{ bag: "28 寸托运箱" }] }] });
    expect(self.text).toContain("is a bag itself");
  });

  it("renames and removes a bag; its rows stay on the list", async () => {
    await call("set_bags", { edit_link: editLink, bags: [{ name: "28 寸托运箱", rename_to: "大箱子" }] });
    const { data } = await call("set_bags", { edit_link: editLink, bags: [{ name: "大箱子", remove: true }] });
    expect((data.bags as unknown[]).length).toBe(1);
    const list = (await call("get_list", { share_code: shareCode })).data;
    const shirt = rows(list).find((x) => x.name === "T 恤")!;
    expect(shirt.in_bags).toEqual([{ bag: "MUJI 登机箱", qty: 2 }]);
  });
});

describe("changing and removing rows over the connector", () => {
  const ids = async () => new Map(rows((await call("get_list", { share_code: shareCode })).data).map((r) => [r.name, r.id]));

  it("changes fields, moves a row to a new folder, and says when a qty cut trimmed its bags", async () => {
    const id = await ids();
    const { data, isError, text } = await call("update_items", {
      edit_link: editLink,
      items: [
        { id: id.get("T 恤"), qty: 1, note: "one is enough" },
        { id: id.get("外套"), name: "Volcom 外套", weight_g: 340, folder: "穿着" },
      ],
    });
    expect(isError, text).toBe(false);
    const [shirt, jacket] = data.updated as { qty: number; folder: string | null; in_bags?: unknown; bags_trimmed?: boolean; display_name: string }[];
    expect(shirt).toMatchObject({ qty: 1, in_bags: [{ bag: "MUJI 登机箱", qty: 1 }], bags_trimmed: true });
    expect(jacket).toMatchObject({ display_name: "Volcom 外套", folder: "穿着" });
    expect(data.folders_made).toEqual(["穿着"]);
    const list = (await call("get_list", { share_code: shareCode })).data;
    const r = rows(list).find((x) => x.name === "T 恤") as Row & { note?: string };
    expect(r.note).toBe("one is enough");
  });

  it("refuses an unknown id, an empty change, and an empty name", async () => {
    const id = await ids();
    expect((await call("update_items", { edit_link: editLink, items: [{ id: "nope", qty: 2 }] })).text).toContain("no row has id");
    expect((await call("update_items", { edit_link: editLink, items: [{ id: id.get("T 恤") }] })).text).toContain("nothing to change");
    expect((await call("update_items", { edit_link: editLink, items: [{ id: id.get("T 恤"), name: " " }] })).text).toContain("can't be empty");
  });

  it("removes a row, taking it out of its bags; a retry reports it missing", async () => {
    const id = await ids();
    const power = id.get("INIU 20K 充电宝")!;
    const first = await call("remove_items", { edit_link: editLink, ids: [power] });
    expect(first.isError, first.text).toBe(false);
    expect(first.data.removed).toEqual([{ id: power, display_name: "INIU 20K 充电宝", nested_under: null }]);
    const again = await call("remove_items", { edit_link: editLink, ids: [power] });
    expect(again.isError).toBe(false);
    expect(again.data.missing).toEqual([power]);
    const list = (await call("get_list", { share_code: shareCode })).data;
    const cabin = (list.bags as { name: string; rows: number }[]).find((b) => b.name === "MUJI 登机箱")!;
    expect(cabin.rows).toBe(1); // just the one T-shirt now
  });

  it("refuses to remove a row that is a bag itself", async () => {
    const id = await ids();
    const res = await call("remove_items", { edit_link: editLink, ids: [id.get("MUJI 登机箱")] });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("set_bags");
  });
});
