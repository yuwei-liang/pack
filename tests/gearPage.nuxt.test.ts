// @vitest-environment nuxt
//
// The /gear page against the vault API's real route table.
//
// The regression this pins: the page rename (#224, /vault → /gear) also rewrote the
// page's OWN fetch URLs to /api/gear/*, but the server routes live at /api/vault/*
// on purpose (see the /vault redirect note in nuxt.config) — so every load answered
// 404 and the page opened straight onto "Couldn’t load your gear." A suite that
// stubs vaultFetch with fixtures can never see that class of bug, so here the stub
// passes through to $fetch and the endpoints are registered at the real paths:
// registerEndpoint 404s anything unregistered, which is exactly what production did.
import { afterEach, describe, expect, it } from "vitest";
import { stubLocalStorage } from "./helpers/storage";
import { flushPromises, mount } from "@vue/test-utils";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { readBody } from "h3";
import type { VaultEntry, VaultFolder } from "~~/shared/vault";
import GearPage from "~/pages/gear.vue";

// hasVault true so the page loads; vaultFetch REAL so the page's URL choice has to
// resolve against the routes below — the same passthrough gearList.nuxt.test.ts uses.
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  // Mirrors the real vaultFetch, including WHY it casts: `$fetch` is generic over
  // the app's routes, so typing the call drags Nuxt's route matcher in and blows
  // TypeScript's depth limit from a mock (see useVaultAccess).
  vaultFetch: <T,>(url: string, opts?: Record<string, unknown>) => {
    const call = $fetch as unknown as (u: string, o: unknown) => Promise<unknown>;
    return call(url, { ...opts, credentials: "same-origin" }) as Promise<T>;
  },
}));

const storage = stubLocalStorage();

const entry = (id: number, name: string): VaultEntry => ({
  id,
  name,
  brand: "Brand",
  weightMg: 250_000,
  normKey: `brand|${name.toLowerCase()}|`,
  timesSeen: 1,
  lastUsedAt: "2026-08-01T00:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
});

let listRows: VaultEntry[] = [];
let listFolders: VaultFolder[] = [];
registerEndpoint("/api/vault/list", () => ({
  items: listRows,
  removed: [],
  folders: listFolders,
}));

// what "Remove" sent — the id is the assertion, the ok is what lets the row leave
let removedIds: number[] = [];
registerEndpoint("/api/vault/remove", {
  method: "POST",
  handler: async (event) => {
    const body = await readBody<{ id: number }>(event);
    removedIds.push(body.id);
    return { ok: true };
  },
});

let wrapper: ReturnType<typeof mount> | undefined;

/** A registered endpoint's round trip crosses more than one task, so a single
 *  flushPromises can return with the response still in flight — loop a few turns. */
async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await flushPromises();
    await nextTick();
  }
}

/** Mount the page and let the load round-trip settle (ClientOnly needs the tick). */
async function openPage() {
  wrapper = mount(GearPage, { attachTo: document.body });
  await settle();
  return wrapper;
}

describe("the /gear page's vault calls", () => {
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    document.body.innerHTML = "";
    storage.clear();
    removedIds = [];
  });

  it("loads the gear from /api/vault/list rather than erroring", async () => {
    listRows = [entry(1, "Duplex"), entry(2, "Kakwa 40")];
    listFolders = [];
    const w = await openPage();
    // the error line rendering instead of rows is exactly the shipped bug
    expect(w.find(".vault__error").exists()).toBe(false);
    const rows = w.findAll(".vault__row");
    expect(rows).toHaveLength(2);
    expect(w.text()).toContain("Duplex");
    expect(w.text()).toContain("Kakwa 40");
  });

  it("removes a row through /api/vault/remove", async () => {
    listRows = [entry(7, "Duplex")];
    listFolders = [];
    const w = await openPage();
    await w.get('button[aria-label="Remove Brand Duplex from My Gear"]').trigger("click");
    await settle();
    expect(removedIds).toEqual([7]);
    expect(w.find(".vault__error").exists()).toBe(false);
    expect(w.findAll(".vault__row")).toHaveLength(0);
  });
});

// Kits (docs/design/my-gear-kits.md §6): a kit row reads its derived weight as a sum,
// opens to its parts, and the totals count each piece once.
describe("a kit on /gear", () => {
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    document.body.innerHTML = "";
    storage.clear();
  });

  const body = { ...entry(11, "Body"), folderId: 1, weightMg: 424_000 };
  const lens = { ...entry(12, "Lens"), folderId: 1, weightMg: 453_000, inKits: [13] };
  const kit: VaultEntry = {
    ...entry(13, "Camera kit"),
    folderId: 2,
    kind: "kit",
    ownWeightMg: 0,
    weightMg: 877_000,
    parts: [
      { id: 11, qty: 1, brand: "Brand", name: "Body", weightMg: 424_000 },
      { id: 12, qty: 1, brand: "Brand", name: "Lens", weightMg: 453_000 },
      { id: 14, qty: 2, brand: "Brand", name: "Old battery", weightMg: 80_000, removed: true },
    ],
  };

  it("shows the kit's sum, counts its parts once, and opens to list them", async () => {
    listRows = [{ ...body, inKits: [13] }, lens, kit];
    listFolders = [
      { id: 1, name: "Photo" },
      { id: 2, name: "Photo · kits" },
    ];
    const w = await openPage();
    const kitRow = w.findAll(".vault__row").find((r) => r.text().includes("Camera kit"))!;
    expect(kitRow.get(".vault__weight").text()).toBe("= 877 g");
    expect(kitRow.text()).toContain("2 parts");
    expect(kitRow.text()).toContain("1 removed");
    // closed by default
    expect(kitRow.find(".vault__parts").exists()).toBe(false);

    // the page counts pieces and kits apart, and weighs each piece once
    expect(w.get(".vault__count").text()).toMatch(/^2 items · 1 kit · 877 g/);
    const sums = w.findAll(".vault__foldersum").map((s) => s.text().replace(/\s+/g, " "));
    expect(sums[0]).toMatch(/^2 ?items · 877 g$/);
    // a folder of kits shows no weight: the parts are counted where they are filed
    expect(sums[1]).toBe("1 kit");

    await kitRow.get(".vault__kittoggle").trigger("click");
    await settle(1);
    const parts = w.findAll(".vault__part");
    expect(parts.map((p) => [p.get(".vault__partname").text(), p.get(".vault__partweight").text()])).toEqual([
      ["Brand Body", "424 g"],
      ["Brand Lens", "453 g"],
      // a removed part stays listed, marked, at its qty — and isn't in the 877 g
      ["Brand Old battery · removed", "160 g"],
    ]);
    expect(parts[2]!.get(".vault__partqty").text()).toBe("×2");
    // tapping a live part opens that piece's own editor
    expect(parts[0]!.get("button.vault__partname").attributes("title")).toBe("Edit Brand Body");
    // and it stays open on this device
    expect(storage.get("gear.vkitopen.13")).toBe("1");

    // a piece in a kit says so, and names it on a tap
    const lensRow = w.findAll(".vault__row").find((r) => r.text().includes("Lens") && !r.text().includes("Camera"))!;
    const chip = lensRow.get(".vault__inkits");
    expect(chip.text()).toBe("In 1 kit");
    await chip.trigger("click");
    expect(chip.text()).toBe("In 1 kit: Brand Camera kit");
  });
});
