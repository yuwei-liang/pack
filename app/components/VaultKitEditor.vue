<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { Cancel01Icon, GripVerticalIcon, Layers01Icon, MinusSignIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import type { Unit } from "~~/shared/types";
import type { VaultEntry, VaultKitPart } from "~~/shared/vault";
import { kitWeightMg, VAULT_NAME_MAX } from "~~/shared/vault";
import { searchVaultRows } from "~~/shared/vaultView";
import { formatWeight, itemDisplayName, parseWeightInput } from "~~/shared/weights";

// A kit, edited where it sits: its name, its parts (how many of each, in what order,
// which ones) and its own weight, without the full dialog. The dialog still holds
// every other field; "All fields" hands over to it.
//
// The same two ops the dialog sends, in the same order (VaultItemModal): the parts
// first, then the name. A kit's parts change OTHER rows (each part's "in N kits"),
// so a save that touched them tells the page to re-read.
const props = defineProps<{
  entry: VaultEntry;
  unit: Unit;
  /** your gear, for the add-a-part search */
  gear: VaultEntry[];
}>();
const emit = defineEmits<{
  /** `item` is the row as saved, absent when nothing changed or it was cancelled */
  done: [item: VaultEntry | null, kitChanged: boolean];
  /** open the full dialog instead */
  more: [];
}>();

const name = ref(props.entry.name);
const parts = ref<VaultKitPart[]>((props.entry.parts ?? []).map((p) => ({ ...p })));
const ownWeight = ref(props.entry.ownWeightMg ? formatWeight(props.entry.ownWeightMg, props.unit, { raw: true }) : "");
const query = ref("");
const saving = ref(false);
const error = ref("");

const partsKey = (ps: VaultKitPart[]) => ps.map((p) => `${p.id}x${p.qty}`).join(",");
const openedParts = partsKey(parts.value);
const openedOwn = ownWeight.value;

const ownWeightMg = computed(() => {
  const raw = ownWeight.value.trim();
  return raw ? parseWeightInput(raw, props.unit) : 0;
});
const totalMg = computed(() => kitWeightMg(ownWeightMg.value ?? 0, parts.value));

// What can go in: your other pieces, not kits (one level deep), not already in it.
const choices = computed(() => {
  const q = query.value.trim();
  if (!q) return [];
  const taken = new Set(parts.value.map((p) => p.id));
  const pool = props.gear.filter((g) => g.kind !== "kit" && g.id !== props.entry.id && !taken.has(g.id));
  return searchVaultRows(pool, q).slice(0, 6);
});
const queryEl = useTemplateRef<HTMLInputElement>("queryEl");
function addPart(g: VaultEntry) {
  parts.value = [...parts.value, { id: g.id, qty: 1, brand: g.brand, name: g.name, variant: g.variant, weightMg: g.weightMg }];
  query.value = "";
  nextTick(() => queryEl.value?.focus());
}
function stepPart(id: number, by: number) {
  parts.value = parts.value.map((p) => (p.id === id ? { ...p, qty: Math.min(99, Math.max(1, p.qty + by)) } : p));
}
function dropPart(id: number) {
  parts.value = parts.value.filter((p) => p.id !== id);
}

// ---- reorder: hold the grip and slide --------------------------------------
// The list reorders under the pointer as it crosses each row's midline, so what you
// see while dragging is the order Done saves. Arrow keys on the grip do the same,
// one step at a time.
const listEl = useTemplateRef<HTMLUListElement>("listEl");
const dragging = ref<number | null>(null);
function move(from: number, to: number) {
  if (to < 0 || to >= parts.value.length || from === to) return;
  const next = parts.value.slice();
  const [p] = next.splice(from, 1);
  next.splice(to, 0, p!);
  parts.value = next;
}
function startDrag(id: number, ev: PointerEvent) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  dragging.value = id;
  // on the WINDOW, not pointer capture on the grip: each reorder moves the grip's row
  // in the DOM, and moving a node drops its capture after the first step
  const onMove = (e: PointerEvent) => {
    const rows = Array.from(listEl.value?.children ?? []) as HTMLElement[];
    const from = parts.value.findIndex((p) => p.id === dragging.value);
    let to = rows.findIndex((r) => {
      const box = r.getBoundingClientRect();
      return e.clientY < box.top + box.height / 2;
    });
    if (to < 0) to = rows.length - 1;
    else if (to > from) to -= 1;
    move(from, to);
  };
  const onUp = () => {
    dragging.value = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
function keyMove(i: number, by: number, ev: KeyboardEvent) {
  move(i, i + by);
  const grip = ev.currentTarget as HTMLElement;
  nextTick(() => grip.focus());
}

const { vaultFetch } = useVaultAccess();
const post = (op: Record<string, unknown>) =>
  vaultFetch<{ ok: boolean; item?: VaultEntry }>("/api/vault/items", { method: "POST", body: { op } }).catch(
    () => ({ ok: false }) as { ok: boolean; item?: VaultEntry },
  );

async function save() {
  if (saving.value) return;
  const trimmed = name.value.trim();
  if (!trimmed) {
    error.value = "A kit needs a name.";
    return;
  }
  const kitChanged = partsKey(parts.value) !== openedParts || ownWeight.value !== openedOwn;
  const renamed = name.value !== props.entry.name;
  if (kitChanged && (ownWeightMg.value == null || ownWeightMg.value < 0)) {
    error.value = "The kit’s own weight doesn’t read as a number. Try “0” or “40 g”.";
    return;
  }
  if (!kitChanged && !renamed) return emit("done", null, false);
  saving.value = true;
  error.value = "";
  let item: VaultEntry | undefined;
  if (kitChanged) {
    const res = await post({
      t: "kit",
      id: props.entry.id,
      parts: parts.value.map((p) => ({ id: p.id, qty: p.qty })),
      ownWeightMg: ownWeightMg.value ?? 0,
    });
    if (!res.ok || !res.item) {
      saving.value = false;
      error.value = "Couldn’t save the parts. Check your connection and try again.";
      return;
    }
    item = res.item;
  }
  if (renamed) {
    const res = await post({ t: "edit", id: props.entry.id, patch: { name: trimmed.slice(0, VAULT_NAME_MAX) } });
    if (!res.ok || !res.item) {
      saving.value = false;
      error.value = "Couldn’t save the name. Check your connection and try again.";
      if (item) emit("done", item, true);
      return;
    }
    item = res.item;
  }
  saving.value = false;
  emit("done", item ?? null, kitChanged);
}

const nameEl = useTemplateRef<HTMLInputElement>("nameEl");
onMounted(() => nameEl.value?.focus());
</script>

<template>
  <!-- pointerdown stops here: the folder list arms a row drag on any press that
       isn't on a button, and a press in these fields is typing, not moving the kit -->
  <form class="kitedit" :aria-label="`Edit the kit ${entry.name}`" @submit.prevent="save" @pointerdown.stop @keydown.esc.stop="emit('done', null, false)">
    <label class="kitedit__name">
      <HugeiconsIcon :icon="Layers01Icon" :size="16" :stroke-width="2" aria-hidden="true" />
      <span class="visually-hidden">Kit name</span>
      <input ref="nameEl" v-model="name" class="field" autocomplete="off" autocorrect="off" spellcheck="false" />
    </label>

    <ul v-if="parts.length" ref="listEl" class="kitedit__parts" aria-label="Parts">
      <li
        v-for="(p, i) in parts"
        :key="p.id"
        class="kitedit__part"
        :class="{ 'is-dragging': dragging === p.id, 'is-removed': p.removed }"
      >
        <button
          type="button"
          class="btn btn--icon btn--ghost grip kitedit__grip"
          :aria-label="`Move ${p.name}: arrow keys`"
          title="Drag to reorder"
          @pointerdown="startDrag(p.id, $event)"
          @keydown.up.prevent="keyMove(i, -1, $event)"
          @keydown.down.prevent="keyMove(i, 1, $event)"
        >
          <HugeiconsIcon :icon="GripVerticalIcon" :size="14" :stroke-width="2" aria-hidden="true" />
        </button>
        <span class="t-clip kitedit__partname">
          {{ itemDisplayName(p.brand, p.name, p.variant) }}<span v-if="p.removed" class="t-muted"> · removed</span>
        </span>
        <span class="kitedit__qty">
          <button
            type="button"
            class="btn btn--icon btn--ghost"
            :disabled="p.qty <= 1"
            :aria-label="`One fewer ${p.name}`"
            @click="stepPart(p.id, -1)"
          >
            <HugeiconsIcon :icon="MinusSignIcon" :size="14" :stroke-width="2" aria-hidden="true" />
          </button>
          <span class="t-num">{{ p.qty }}</span>
          <button type="button" class="btn btn--icon btn--ghost" :aria-label="`One more ${p.name}`" @click="stepPart(p.id, 1)">
            <HugeiconsIcon :icon="PlusSignIcon" :size="14" :stroke-width="2" aria-hidden="true" />
          </button>
        </span>
        <span class="t-num kitedit__weight">{{ formatWeight(p.weightMg * p.qty, unit) }}</span>
        <button
          type="button"
          class="btn btn--icon btn--ghost kitedit__drop"
          :aria-label="`Take ${p.name} out of the kit`"
          :title="`Take ${p.name} out of the kit`"
          @click="dropPart(p.id)"
        >
          <HugeiconsIcon :icon="Cancel01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
        </button>
      </li>
    </ul>
    <p v-else class="t-sm t-muted kitedit__hint">
      No parts left. Done turns it back into a single piece.
    </p>

    <div class="kitedit__add">
      <input
        ref="queryEl"
        v-model="query"
        class="field"
        placeholder="Add a part from your gear"
        aria-label="Find a part in your gear"
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
        @keydown.enter.prevent="choices[0] && addPart(choices[0])"
      />
      <ul v-if="choices.length" class="kitedit__choices">
        <li v-for="g in choices" :key="g.id">
          <button type="button" class="kitedit__choice" @click="addPart(g)">
            <span class="t-clip">{{ itemDisplayName(g.brand, g.name, g.variant) }}</span>
            <span class="t-sm t-num t-muted">{{ formatWeight(g.weightMg, unit) }}</span>
          </button>
        </li>
      </ul>
      <p v-else-if="query.trim()" class="t-sm t-muted kitedit__hint">
        None of your gear matches. Add the piece to My Gear first, then pick it here.
      </p>
    </div>

    <label class="kitedit__own">
      <span class="t-sm t-muted">Its own weight (a case, a strap)</span>
      <input
        v-model="ownWeight"
        class="field t-num"
        :placeholder="`0 ${unit}`"
        inputmode="decimal"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
      />
    </label>

    <p v-if="error" class="t-sm kitedit__err">{{ error }}</p>

    <div class="kitedit__foot">
      <span class="t-sm t-num t-muted">= {{ formatWeight(totalMg, unit) }}</span>
      <button type="button" class="btn btn--link t-sm kitedit__more" @click="emit('more')">All fields</button>
      <button type="button" class="btn btn--ghost" @click="emit('done', null, false)">Cancel</button>
      <button type="submit" class="btn btn--primary" :disabled="saving">{{ saving ? "Saving…" : "Done" }}</button>
    </div>
  </form>
</template>

<style scoped lang="scss">
.kitedit {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
/* the row's name line, become a field: the kit glyph where the card shows it, and
   an input that looks like one, since this is the one place a kit is renamed inline */
.kitedit__name {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  color: var(--ink-2);
}
.kitedit__name .field {
  flex: 1 1 auto;
  min-width: 0;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--line-2);
  border-radius: var(--radius-2);
  color: var(--ink);
}
.kitedit__parts,
.kitedit__choices {
  margin: 0;
  padding: 0;
  list-style: none;
}
.kitedit__part {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--icon-btn);
  background: var(--paper-2);
}
.kitedit__part + .kitedit__part {
  border-top: 1px solid var(--line);
}
.kitedit__part.is-dragging {
  background: var(--lit);
}
.kitedit__part.is-removed .kitedit__partname {
  color: var(--ink-3);
}
.kitedit__grip {
  flex: none;
  color: var(--ink-3);
  cursor: grab;
  touch-action: none;
}
.kitedit__part.is-dragging .kitedit__grip {
  cursor: grabbing;
}
.kitedit__partname {
  flex: 1 1 auto;
  min-width: 0;
}
.kitedit__qty {
  flex: none;
  display: inline-flex;
  align-items: center;
}
.kitedit__qty .t-num {
  min-width: 2.2ch;
  text-align: center;
}
.kitedit__weight {
  flex: none;
  min-width: 4.5rem;
  text-align: right;
  color: var(--ink-2);
}
.kitedit__drop {
  flex: none;
  color: var(--ink-3);
}
.kitedit__hint,
.kitedit__err {
  margin: 0;
}
.kitedit__err {
  color: var(--ink);
}
.kitedit__add {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.kitedit__choices {
  border: 1px solid var(--line);
  border-radius: var(--radius-2);
  overflow: hidden;
}
.kitedit__choices li + li {
  border-top: 1px solid var(--line);
}
.kitedit__choice {
  display: flex;
  width: 100%;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 0;
  background: none;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.kitedit__choice:hover,
.kitedit__choice:focus-visible {
  background: var(--popover-hover);
}
.kitedit__own {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.kitedit__own .field {
  width: 8rem;
}
.kitedit__foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.kitedit__foot > :first-child {
  margin-right: auto;
}
@media (max-width: $bp-stack) {
  .kitedit__own {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-1);
  }
  .kitedit__own .field {
    width: 100%;
  }
}
</style>
