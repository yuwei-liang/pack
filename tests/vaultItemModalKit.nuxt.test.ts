// @vitest-environment nuxt
//
// MY GEAR'S EDIT DIALOG makes a row a kit: its Parts are picked from your own gear, and
// Save sends them as the "kit" op. What's pinned here is what reaches the server — the
// parts and quantities, the own weight rather than the old typed total, and the order
// of the two writes (a row that stops being a kit takes a weight only as a piece).
import { beforeEach, describe, expect, it } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { flushPromises, mount } from "@vue/test-utils";
import VaultItemModal from "~/components/VaultItemModal.vue";
import type { VaultEntry } from "~~/shared/vault";

const sent: { op: Record<string, unknown> }[] = [];
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  vaultKnown: ref(true),
  vaultFetch: (_url: string, opts?: { body?: { op: Record<string, unknown> } }) => {
    sent.push(opts!.body!);
    return Promise.resolve({ ok: true, item: entry(1, "saved") });
  },
}));

const entry = (id: number, name: string, over: Partial<VaultEntry> = {}): VaultEntry => ({
  id,
  normKey: name.toLowerCase(),
  name,
  weightMg: 100_000,
  timesSeen: 1,
  lastUsedAt: "2026-10-01T00:00:00Z",
  createdAt: "2026-10-01T00:00:00Z",
  ...over,
});

const kitRow = entry(1, "X-S20 拍摄套装", { weightMg: 1_126_000 });
const gear = [
  kitRow,
  entry(2, "X-S20 body", { weightMg: 491_000 }),
  entry(3, "NP-W235", { weightMg: 81_000 }),
  entry(4, "Other kit", { kind: "kit", ownWeightMg: 0, parts: [] }),
];

function open(e: VaultEntry) {
  return mount(VaultItemModal, { props: { entry: e, unit: "g", gear }, attachTo: document.body });
}
type W = ReturnType<typeof open>;
const search = (w: W) => w.get('input[aria-label="Find a part in your gear"]');
const choices = (w: W) => w.findAll(".vitem__choice").map((c) => c.text());
async function pick(w: W, query: string) {
  await search(w).setValue(query);
  await w.findAll(".vitem__choice")[0]!.trigger("click");
}
const save = async (w: W) => {
  await w.get("button.btn--primary").trigger("click");
  await flushPromises();
};

describe("the edit dialog's Parts", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("offers your other pieces — not this row, not a kit", async () => {
    const w = open(kitRow);
    await search(w).setValue("kit");
    expect(choices(w)).toEqual([]);
    await search(w).setValue("x-s20");
    expect(choices(w)).toHaveLength(1);
    expect(choices(w)[0]).toContain("X-S20 body");
    w.unmount();
  });

  it("makes a piece a kit of the parts picked, with its own weight, not its typed total", async () => {
    const w = open(kitRow);
    await pick(w, "body");
    await pick(w, "NP-W235");
    await w.findAll('button[aria-label="One more NP-W235"]')[0]!.trigger("click");
    expect(w.get(".vitem__derived").text()).toContain("653");
    await save(w);
    expect(sent).toEqual([
      { op: { t: "kit", id: 1, parts: [{ id: 2, qty: 1 }, { id: 3, qty: 2 }], ownWeightMg: 0 } },
    ]);
    expect(w.emitted("saved")![0]![1]).toBe(true);
    w.unmount();
  });

  it("turns a kit back into a piece before writing a weight typed for it", async () => {
    const kit = entry(1, "Camera kit", {
      kind: "kit",
      ownWeightMg: 0,
      weightMg: 491_000,
      parts: [{ id: 2, qty: 1, name: "X-S20 body", weightMg: 491_000 }],
    });
    const w = open(kit);
    await w.get('button[aria-label="Take X-S20 body out of the kit"]').trigger("click");
    const weight = w.findAll("label.dlg__field").find((l) => l.text().startsWith("Weight"))!.get("input");
    await weight.setValue("500 g");
    await save(w);
    expect(sent.map((b) => b.op.t)).toEqual(["kit", "edit"]);
    expect(sent[0]!.op).toMatchObject({ parts: [] });
    expect(sent[1]!.op).toMatchObject({ patch: { weightMg: 500_000 } });
    w.unmount();
  });

  it("has no Parts on a piece that is already some kit's part", async () => {
    const w = open(entry(3, "NP-W235", { inKits: [9] }));
    expect(w.find('input[aria-label="Find a part in your gear"]').exists()).toBe(false);
    expect(w.text()).toContain("Part of a kit");
    w.unmount();
  });
});
