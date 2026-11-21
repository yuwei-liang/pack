<script setup lang="ts">
import { BAG_KIND_LABELS, planBags, sortedBags, type BagEntry } from "~~/shared/bags";
import { MAX_BAG_NAME_LEN, MAX_BAGS } from "~~/shared/ops";
import { sortedPeople } from "~~/shared/people";
import { BAG_KINDS, type Bag, type BagKind, type Item, type ListSnapshot, type Placement } from "~~/shared/types";
import { bySortOrder, formatWeight, formatWeightAuto, itemDisplayName, unitSystem } from "~~/shared/weights";

// The list grouped by BAG instead of by folder — the second of the two ways to read a
// trip. By folder answers "did I forget anything" (folders are categories: 摄影, 洗漱);
// by bag answers "what goes in the carry-on, and is it over 10 kg". The rows are the
// same rows: a folder is what a thing IS, a bag is where it TRAVELS (shared/bags.ts).
//
// Three faces off one prop. `edit`: place rows, split a quantity between bags, manage
// the bags. `pack`: the night-before checklist, one tick per share (two T-shirts in
// each bag are two ticks). `read`: the share link's view, no controls.
//
// Writes go through the editor's controller like every editor surface; on the read
// face nothing here writes, so the controller is never touched.

const props = defineProps<{
  list: ListSnapshot;
  mode: "edit" | "pack" | "read";
}>();

const c = props.mode === "read" ? null : useGearList();
const plan = computed(() => planBags(props.list));
const bags = computed(() => sortedBags(props.list.bags));
const people = computed(() => sortedPeople(props.list.people));
const folderName = computed(() => new Map(props.list.folders.map((f) => [f.id, f.name])));
const system = computed(() => unitSystem(props.list.displayUnit));
const kg = (mg: number) => formatWeightAuto(mg, { system: system.value });
const limitText = (mg: number) => formatWeight(mg, system.value === "imperial" ? "lb" : "kg");

const name = (it: Item) => itemDisplayName(it.brand, it.name, it.variant) || "（未命名）";
const ownerName = (b: Bag) => people.value.find((p) => p.id === b.personId)?.name;

// ---- placing ----
// A share moves by rewriting the row's WHOLE placements list (setPlacements), so a move
// can't half-apply: take n out of `from`, add n to `to`, merge.
function ownShares(it: Item): Placement[] {
  return (it.placements ?? []).map((p) => ({ bagId: p.bagId, qty: p.qty }));
}
function withShare(shares: Placement[], bagId: string, n: number): Placement[] {
  const out = shares.map((p) => ({ ...p }));
  const at = out.find((p) => p.bagId === bagId);
  if (at) at.qty += n;
  else out.push({ bagId, qty: n });
  return out.filter((p) => p.qty > 0);
}
/** an unplaced row (or the unplaced part of one) into a bag */
function place(it: Item, bagId: string, n: number) {
  if (!c || !bagId || n <= 0) return;
  c.setPlacements(it.id, withShare(ownShares(it), bagId, n));
}
/** a share from one bag to another, or out of every bag (to = "") */
function move(e: BagEntry, from: string, to: string, n = e.qty) {
  if (!c) return;
  // an inherited share (a nested row riding with its parent) becomes the row's own
  // the moment it's moved: from then on it goes where it was put
  let shares = e.inherited ? [{ bagId: from, qty: e.item.qty }] : ownShares(e.item);
  shares = withShare(shares, from, -n);
  if (to) shares = withShare(shares, to, n);
  c.setPlacements(e.item.id, shares);
}

// per-row "how many" for a split, keyed by row id + bag (or "u" for unplaced)
const splitQty = reactive<Record<string, number>>({});
const qtyKey = (id: string, bag: string) => `${id}\u0000${bag}`;
const qtyFor = (id: string, bag: string, max: number) => Math.min(max, Math.max(1, splitQty[qtyKey(id, bag)] ?? max));

function onPlace(it: Item, max: number, ev: Event) {
  const el = ev.target as HTMLSelectElement;
  place(it, el.value, qtyFor(it.id, "u", max));
  el.value = "";
}
function onMove(e: BagEntry, from: string, ev: Event) {
  const el = ev.target as HTMLSelectElement;
  const to = el.value;
  el.value = "-";
  if (to === "-") return;
  move(e, from, to === "out" ? "" : to, qtyFor(e.item.id, from, e.qty));
}

// ---- packing ----
function tick(e: BagEntry, bagId: string, packed: boolean) {
  if (!c) return;
  // an inherited share has no placement of its own to tick; its tick is the row's
  if (e.inherited) c.updateItem(e.item.id, { packed });
  else c.packPlacement(e.item.id, bagId, packed);
}

// ---- managing bags ----
const managing = ref(false);
const draftName = ref("");
const draftKind = ref<BagKind>("carry-on");
const atCap = computed(() => bags.value.length >= MAX_BAGS);
/** rows that could be a bag's own row: top-level, not already some bag's */
const bagRowOptions = computed(() =>
  props.list.items.filter((i) => !i.parentId).slice().sort(bySortOrder),
);
function addBag() {
  const n = draftName.value.trim();
  if (!c || !n || atCap.value) return;
  // a row of the same name is almost certainly the bag itself — link it, so its
  // weight is the empty weight without a second step
  const row = props.list.items.find(
    (i) => !i.parentId && name(i).trim().toLowerCase() === n.toLowerCase() && !bags.value.some((b) => b.itemId === i.id),
  );
  c.addBag(n, draftKind.value, row?.id);
  draftName.value = "";
}
function rename(b: Bag, ev: Event) {
  const el = ev.target as HTMLInputElement;
  const v = el.value.trim();
  if (!v) {
    el.value = b.name;
    return;
  }
  if (v !== b.name) c?.updateBag(b.id, { name: v });
}
function setLimit(b: Bag, ev: Event) {
  const raw = (ev.target as HTMLInputElement).value.trim();
  const n = Number(raw);
  const perUnit = system.value === "imperial" ? 453_592.37 : 1_000_000;
  c?.updateBag(b.id, { limitMg: raw && Number.isFinite(n) && n > 0 ? Math.round(n * perUnit) : null });
}
const limitInput = (b: Bag) =>
  b.limitMg ? String(Math.round((b.limitMg / (system.value === "imperial" ? 453_592.37 : 1_000_000)) * 100) / 100) : "";
const otherBags = (id: string) => bags.value.filter((b) => b.id !== id);
</script>

<template>
  <div class="bagview" :data-mode="mode">
    <p v-if="!bags.length && mode !== 'edit'" class="bagview__empty t-sm">这张清单还没有箱子。</p>

    <section
      v-for="s in plan.bags"
      :key="s.bag.id"
      class="panel bagview__bag"
      :class="{ 'is-over': s.over }"
    >
      <header class="bagview__head">
        <div class="bagview__title">
          <span class="bagview__name">{{ s.bag.name }}</span>
          <span class="bagview__kind t-sm">{{ BAG_KIND_LABELS[s.bag.kind] }}<template v-if="ownerName(s.bag)"> · {{ ownerName(s.bag) }}</template></span>
        </div>
        <div class="bagview__weight t-num">
          <span class="bagview__total">{{ kg(s.totalMg) }}</span>
          <span v-if="s.bag.limitMg" class="bagview__limit"> / {{ limitText(s.bag.limitMg) }}</span>
          <span v-if="s.over" class="bagview__over">超重</span>
        </div>
      </header>
      <p class="bagview__meta t-sm">
        <template v-if="s.bag.itemId">空箱 {{ s.tareUnweighed ? "未称重" : kg(s.tareMg) }} · </template>
        <template v-else-if="mode === 'edit'">空箱重量未关联 · </template>
        {{ s.entries.length }} 项
        <template v-if="s.unweighed"> · {{ s.unweighed }} 项未称重（总重偏低）</template>
      </p>

      <ul v-if="s.entries.length" class="bagview__rows">
        <li
          v-for="e in s.entries"
          :key="e.item.id"
          class="bagview__row"
          :class="{ 'is-packed': e.packed }"
        >
          <label v-if="mode === 'pack'" class="bagview__tick">
            <input
              type="checkbox"
              :checked="e.packed"
              @change="tick(e, s.bag.id, ($event.target as HTMLInputElement).checked)"
            />
          </label>
          <div class="bagview__what">
            <span class="bagview__itemname">
              <template v-if="e.parent">{{ name(e.parent) }} › </template>{{ name(e.item) }}
            </span>
            <span class="bagview__sub t-sm">
              {{ folderName.get(e.item.folderId ?? "") ?? "未分类" }}<template v-if="e.item.unitWeightMg">
                · {{ kg(e.item.unitWeightMg * e.qty) }}</template
              ><template v-if="e.qty < e.item.qty"> · 共 {{ e.item.qty }} 件，这里 {{ e.qty }}</template
              ><template v-if="e.inherited"> · 随上级</template>
            </span>
          </div>
          <span class="bagview__qty t-num">×{{ e.qty }}</span>
          <div v-if="mode === 'edit'" class="bagview__ctl">
            <input
              v-if="e.qty > 1"
              class="field field--num bagview__n"
              type="number"
              min="1"
              :max="e.qty"
              :value="qtyFor(e.item.id, s.bag.id, e.qty)"
              :aria-label="`移动几件 ${name(e.item)}`"
              @input="splitQty[qtyKey(e.item.id, s.bag.id)] = Number(($event.target as HTMLInputElement).value)"
            />
            <select
              class="field bagview__select"
              :aria-label="`把 ${name(e.item)} 移到`"
              @change="onMove(e, s.bag.id, $event)"
            >
              <option value="-" selected>移到…</option>
              <option v-for="b in otherBags(s.bag.id)" :key="b.id" :value="b.id">{{ b.name }}</option>
              <option value="out">取出（不装箱）</option>
            </select>
          </div>
        </li>
      </ul>
      <p v-else class="bagview__none t-sm">空</p>
    </section>

    <section v-if="plan.unplaced.length && bags.length" class="panel bagview__bag bagview__unplaced">
      <header class="bagview__head">
        <div class="bagview__title">
          <span class="bagview__name">未装箱</span>
          <span class="bagview__kind t-sm">{{ plan.unplaced.length }} 项</span>
        </div>
      </header>
      <ul class="bagview__rows">
        <li v-for="u in plan.unplaced" :key="u.item.id" class="bagview__row">
          <div class="bagview__what">
            <span class="bagview__itemname">
              <template v-if="u.parent">{{ name(u.parent) }} › </template>{{ name(u.item) }}
            </span>
            <span class="bagview__sub t-sm">
              {{ folderName.get(u.item.folderId ?? "") ?? "未分类" }}<template v-if="u.qty < u.item.qty">
                · 共 {{ u.item.qty }} 件，还剩 {{ u.qty }}</template
              >
            </span>
          </div>
          <span class="bagview__qty t-num">×{{ u.qty }}</span>
          <div v-if="mode === 'edit'" class="bagview__ctl">
            <input
              v-if="u.qty > 1"
              class="field field--num bagview__n"
              type="number"
              min="1"
              :max="u.qty"
              :value="qtyFor(u.item.id, 'u', u.qty)"
              :aria-label="`装几件 ${name(u.item)}`"
              @input="splitQty[qtyKey(u.item.id, 'u')] = Number(($event.target as HTMLInputElement).value)"
            />
            <select
              class="field bagview__select"
              :aria-label="`把 ${name(u.item)} 装进`"
              @change="onPlace(u.item, u.qty, $event)"
            >
              <option value="" selected>装进…</option>
              <option v-for="b in bags" :key="b.id" :value="b.id">{{ b.name }}</option>
            </select>
          </div>
        </li>
      </ul>
    </section>

    <!-- managing the bags: edit face only -->
    <div v-if="mode === 'edit'" class="bagview__manage">
      <form class="bagview__add" @submit.prevent="addBag">
        <input
          v-model="draftName"
          class="field"
          :maxlength="MAX_BAG_NAME_LEN"
          placeholder="新箱子，如 28 寸托运箱"
          aria-label="新箱子的名字"
          :disabled="atCap"
        />
        <select v-model="draftKind" class="field" aria-label="箱子类型">
          <option v-for="k in BAG_KINDS" :key="k" :value="k">{{ BAG_KIND_LABELS[k] }}</option>
        </select>
        <button class="btn" type="submit" :disabled="!draftName.trim() || atCap">添加箱子</button>
      </form>
      <p class="t-sm bagview__hint">
        和清单里某一行同名时，会自动用那一行的重量作为空箱重量。
      </p>
      <button v-if="bags.length" type="button" class="btn btn--link" @click="managing = !managing">
        {{ managing ? "收起箱子设置" : "箱子设置（类型、归属、限重、空箱行）" }}
      </button>
      <div v-if="managing" class="bagview__settings">
        <div v-for="b in bags" :key="b.id" class="panel bagview__setting">
          <input
            class="field"
            :value="b.name"
            :maxlength="MAX_BAG_NAME_LEN"
            aria-label="箱子名字"
            @change="rename(b, $event)"
          />
          <label class="bagview__field t-sm">类型
            <select
              class="field"
              :value="b.kind"
              @change="c?.updateBag(b.id, { kind: ($event.target as HTMLSelectElement).value as BagKind })"
            >
              <option v-for="k in BAG_KINDS" :key="k" :value="k">{{ BAG_KIND_LABELS[k] }}</option>
            </select>
          </label>
          <label class="bagview__field t-sm">归属
            <select
              class="field"
              :value="b.personId ?? ''"
              @change="c?.updateBag(b.id, { personId: ($event.target as HTMLSelectElement).value || null })"
            >
              <option value="">共用 / 不指定</option>
              <option v-for="p in people" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </label>
          <label class="bagview__field t-sm">限重（{{ system === "imperial" ? "lb" : "kg" }}）
            <input
              class="field field--num"
              type="number"
              min="0"
              step="0.1"
              :value="limitInput(b)"
              placeholder="不限"
              @change="setLimit(b, $event)"
            />
          </label>
          <label class="bagview__field t-sm">空箱行
            <select
              class="field"
              :value="b.itemId ?? ''"
              @change="c?.updateBag(b.id, { itemId: ($event.target as HTMLSelectElement).value || null })"
            >
              <option value="">不关联</option>
              <option
                v-for="i in bagRowOptions"
                :key="i.id"
                :value="i.id"
                :disabled="bags.some((x) => x.id !== b.id && x.itemId === i.id)"
              >{{ name(i) }}</option>
            </select>
          </label>
          <button type="button" class="btn btn--quiet bagview__remove" @click="c?.removeBag(b.id)">
            删除箱子（物品留在清单里）
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.bagview {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.bagview__bag {
  padding: var(--space-3) var(--space-4);
  min-width: 0;
}
.bagview__bag.is-over {
  border-color: var(--danger);
}
.bagview__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.bagview__title {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  flex-wrap: wrap;
}
.bagview__name {
  font-weight: 600;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.bagview__kind,
.bagview__meta,
.bagview__sub,
.bagview__none,
.bagview__hint,
.bagview__empty {
  color: var(--ink-3);
}
.bagview__meta {
  margin-top: var(--space-1);
}
.bagview__weight {
  white-space: nowrap;
}
.bagview__total {
  font-weight: 600;
}
.is-over .bagview__total,
.bagview__over {
  color: var(--danger);
}
.bagview__over {
  margin-left: var(--space-1);
  font-weight: 600;
}
.bagview__rows {
  list-style: none;
  margin: var(--space-2) 0 0;
  padding: 0;
}
.bagview__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) 0;
  border-top: 1px solid var(--line);
  flex-wrap: wrap;
}
.bagview__row.is-packed .bagview__itemname {
  color: var(--ink-3);
  text-decoration: line-through;
}
.bagview__tick input {
  width: 20px;
  height: 20px;
}
.bagview__what {
  display: flex;
  flex-direction: column;
  flex: 1 1 10rem;
  min-width: 0;
}
.bagview__itemname {
  overflow-wrap: anywhere;
}
.bagview__qty {
  color: var(--ink-2);
}
.bagview__ctl {
  display: flex;
  gap: var(--space-1);
  align-items: center;
  margin-left: auto;
}
.bagview__n {
  width: 3.5rem;
}
.bagview__select {
  max-width: 10rem;
}
.bagview__manage {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  align-items: flex-start;
}
.bagview__add {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  width: 100%;
}
.bagview__add .field:first-child {
  flex: 1 1 12rem;
  min-width: 0;
}
.bagview__settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: 100%;
}
.bagview__setting {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-3);
  align-items: flex-end;
}
.bagview__setting > .field:first-child {
  flex: 1 1 100%;
}
.bagview__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  color: var(--ink-2);
  flex: 1 1 8rem;
  min-width: 0;
}
.bagview__field .field {
  width: 100%;
}
.bagview__remove {
  color: var(--danger);
}
</style>
