<script setup lang="ts">
import {
  acceptedCarryUnit,
  carryGear,
  carryWeight,
  selectedCarryRoots,
  type CarryRequest,
  type CarryUnit,
  type CarryGear,
} from "~~/shared/carry";
import { carrySummary } from "~~/shared/carryActivity";
import type { ListSnapshot } from "~~/shared/types";
import { computeTotals, formatWeight } from "~~/shared/weights";
const props = defineProps<{
  list?: ListSnapshot;
  headers?: Record<string, string>;
  ready?: boolean;
  inlineSelection?: boolean;
  requestOpen?: number;
  requestOnly?: boolean;
  packingOnly?: boolean;
}>();
const session = useSession();
const claimed = useClaimedLists();
const account = useAccountModal();
const requests = ref<CarryRequest[]>([]);
const drafts = ref<Record<string, CarryRequest>>({});
const error = ref("");
const notice = ref("");
const busy = ref(false);
const loading = ref(false);
const expanded = ref(false);
const notify = ref(false);
const selected = defineModel<string[]>("selected", { default: () => [] });
const emit = defineEmits<{
  created: [];
  activity: [requests: CarryRequest[]];
}>();
watch(
  () => props.requestOpen,
  (value) => {
    if (value) expanded.value = true;
  },
  { immediate: true },
);
const members = ref<{ name: string; email: string }[]>([]);
watch(requests, (value) => emit("activity", value));
function chooseMember(event: Event) {
  const member = members.value.find(
    (m) => m.email === (event.target as HTMLSelectElement).value,
  );
  if (member) {
    name.value = member.name;
    email.value = member.email;
  } else {
    email.value = "";
  }
}
const email = ref("");
const name = ref("Molly");
const note = ref("");
const memberName = ref(""),
  memberEmail = ref("");
async function saveMember() {
  try {
    await $fetch("/api/carry/members", {
      method: "POST",
      body: {
        action: "save",
        name: memberName.value,
        email: memberEmail.value,
      },
    });
    memberName.value = "";
    memberEmail.value = "";
    await refresh();
  } catch (e) {
    error.value = message(e);
  }
}
async function removeMember(email: string) {
  try {
    await $fetch("/api/carry/members", {
      method: "POST",
      body: { action: "remove", email },
    });
    await refresh();
  } catch (e) {
    error.value = message(e);
  }
}
const query = ref("");
const weight = (n: number) => formatWeight(n, "g");
const matches = computed(
  () =>
    props.list?.items.filter((i) =>
      [i.brand, i.name, i.variant]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query.value.toLowerCase()),
    ) ?? [],
);
const roots = computed(() =>
  props.list ? selectedCarryRoots(props.list, selected.value) : [],
);
const selectionWeight = computed(() =>
  props.list
    ? roots.value.reduce(
        (n, id) => n + carryWeight(carryGear(props.list!, id)),
        0,
      )
    : 0,
);
const outgoing = computed(() =>
  requests.value.filter(
    (r) => r.outgoing && (!props.list || r.sourceCode === props.list.shareCode),
  ),
);
const incoming = computed(() => requests.value.filter((r) => !r.outgoing && (!props.list || r.destinationCode === props.list.shareCode)));
const activeIncoming = computed(() =>
  incoming.value.filter(
    (r) =>
      !r.cancelled &&
      (!props.list || r.destinationCode === props.list.shareCode),
  ),
);
const transferred = computed(() => {
  const seen = new Set<string>();
  let n = 0;
  for (const r of outgoing.value)
    if (!r.cancelled)
      for (const u of r.units)
        if (acceptedCarryUnit(u))
          for (const g of u.gear)
            if (!seen.has(g.id)) {
              seen.add(g.id);
              n += g.weightMg * g.qty;
            }
  return n;
});
type PackingRow = {
  request: CarryRequest;
  unit: CarryUnit;
  gear: CarryGear;
  group: string;
  position: number;
  kit: string;
};
const packing = computed(() => {
  const rows: PackingRow[] = [];
  for (const r of activeIncoming.value)
    for (const [unitIndex, u] of r.units.entries())
      if (acceptedCarryUnit(u))
        for (const [gearIndex, g] of u.gear.entries())
          rows.push({
            request: r,
            unit: u,
            gear: g,
            group: u.groups[g.id] || "替别人背",
            position:
              u.positions?.[g.id] ??
              Date.parse(r.createdAt) / 1000 +
                unitIndex * 0.1 +
                gearIndex * 0.001,
            kit: g.parentId ? (u.gear[0]?.name ?? "") : "",
          });
  return rows.sort((a, b) => a.position - b.position);
});
const groups = computed(() =>
  [...new Set(packing.value.map((r) => r.group))].map((name) => ({
    name,
    rows: packing.value.filter((r) => r.group === name),
  })),
);
const inboundWeight = computed(() =>
  packing.value.reduce((n, r) => n + r.gear.weightMg * r.gear.qty, 0),
);
const knownGroups = computed(() => [
  ...new Set([
    ...(props.list?.folders.map((f) => f.name) ?? []),
    ...groups.value.map((g) => g.name),
    "炊事",
    "帐篷与遮蔽",
    "背包外侧",
    "替别人背",
  ]),
]);
const netWeight = computed(() =>
  props.list
    ? computeTotals(props.list).totalMg -
      transferred.value +
      inboundWeight.value
    : inboundWeight.value,
);
function message(e: unknown) {
  return (
    (e as { data?: { statusMessage?: string }; message?: string }).data
      ?.statusMessage ||
    (e as Error).message ||
    "操作失败，请重试"
  );
}
let fetchEpoch = 0;
async function refresh() {
  const epoch = ++fetchEpoch;
  const owner = session.user.value?.owner;
  if (!session.user.value?.email) {
    requests.value = [];
    members.value = [];
    drafts.value = {};
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const [res, contacts] = await Promise.all([
      $fetch<{ requests: CarryRequest[] }>("/api/carry"),
      $fetch<{ members: { name: string; email: string }[] }>(
        "/api/carry/members",
      ),
    ]);
    if (epoch === fetchEpoch && owner === session.user.value?.owner) {
      requests.value = res.requests;
      members.value = contacts.members;
    }
  } catch (e) {
    if (epoch === fetchEpoch) error.value = message(e);
  } finally {
    if (epoch === fetchEpoch) loading.value = false;
  }
}
function edit(r: CarryRequest) {
  if (!drafts.value[r.id]) drafts.value[r.id] = structuredClone(toRaw(r));
}
function label(u: CarryUnit) {
  return u.unavailable
    ? "装备已删除"
    : u.needsReview
      ? "内容变更 · 请重新确认"
      : { pending: "待确认", accepted: "已接受", declined: "已婉拒" }[
          u.decision
        ];
}
function setKitGroup(u: CarryUnit, group: string) {
  for (const g of u.gear) u.groups[g.id] = group;
}
async function create() {
  if (!props.list || busy.value || props.ready === false) return;
  error.value = "";
  notice.value = "";
  busy.value = true;
  try {
    const result = await $fetch<{ notification: string }>("/api/carry", {
      method: "POST",
      headers: props.headers,
      body: {
        action: "create",
        listVersion: props.list.version,
        email: email.value,
        name: name.value,
        ids: roots.value,
        note: note.value,
        notify: notify.value,
      },
    });
    selected.value = [];
    expanded.value = false;
    emit("created");
    notice.value =
      result.notification === "sent"
        ? "请求已保存，提醒邮件已发送。"
        : result.notification === "failed"
          ? "请求已保存，但提醒邮件未发出。请把收件箱链接分享给对方。"
          : "请求已保存。请把收件箱链接分享给对方，让对方用这个邮箱登录。";
    await refresh();
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}
async function mutate(
  r: CarryRequest,
  action: "reply" | "organize" | "cancel",
  destinationCode?: string | null,
) {
  if (busy.value) return;
  const hadDraft = !!drafts.value[r.id];
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await $fetch("/api/carry", {
      method: "POST",
      body: {
        id: r.id,
        version: r.version,
        action,
        units: r.units,
        reply: r.reply,
        ...(destinationCode !== undefined
          ? { destinationCode }
          : action === "reply"
            ? { destinationCode: r.destinationCode || null }
            : {}),
      },
    });
    delete drafts.value[r.id];
    await refresh();
    notice.value =
      action === "cancel" ? "请求已取消，重量已归回来源清单。" : "已保存";
  } catch (e) {
    error.value = message(e);
    delete drafts.value[r.id];
    await refresh();
  } finally {
    if (hadDraft) {
      const fresh = requests.value.find((v) => v.id === r.id);
      if (fresh && !fresh.cancelled)
        drafts.value[r.id] = structuredClone(toRaw(fresh));
    }
    busy.value = false;
  }
}
async function copyInbox() {
  try {
    await navigator.clipboard.writeText(window.location.origin + "/carry");
    notice.value = "收件箱链接已复制，对方用自己的邮箱登录即可。";
  } catch {
    notice.value = "收件箱地址：" + window.location.origin + "/carry";
  }
}
async function groupRow(row: PackingRow, value: string) {
  const r = structuredClone(toRaw(row.request));
  const u = r.units.find((u) => u.rootId === row.unit.rootId)!;
  if (row.gear.id === u.rootId) setKitGroup(u, value);
  else u.groups[row.gear.id] = value;
  await mutate(r, "organize");
}
async function packedRow(row: PackingRow, value: boolean) {
  const r = structuredClone(toRaw(row.request));
  const u = r.units.find((u) => u.rootId === row.unit.rootId)!;
  for (const g of row.gear.id === u.rootId ? u.gear : [row.gear])
    u.packed[g.id] = value;
  await mutate(r, "organize");
}
async function move(row: PackingRow, direction: number) {
  const peers = packing.value.filter((r) => r.group === row.group);
  const index = peers.findIndex(
    (r) => r.request.id === row.request.id && r.gear.id === row.gear.id,
  );
  const target = index + direction;
  if (target < 0 || target >= peers.length) return;
  const before = direction < 0 ? peers[target - 1] : peers[target];
  const after = direction < 0 ? peers[target] : peers[target + 1];
  const position =
    before && after
      ? (before.position + after.position) / 2
      : before
        ? before.position + 1000
        : after!.position - 1000;
  const r = structuredClone(toRaw(row.request));
  const u = r.units.find((u) => u.rootId === row.unit.rootId)!;
  u.positions = { ...u.positions, [row.gear.id]: position };
  await mutate(r, "organize");
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  await session.refresh();
  if (session.signedIn.value) await claimed.refresh();
  await refresh();
  timer = setInterval(() => {
    if (document.visibilityState === "visible" && !busy.value) void refresh();
  }, 20000);
});
onBeforeUnmount(() => clearInterval(timer));
watch(
  () => session.user.value?.owner,
  () => {
    drafts.value = {};
    requests.value = [];
    members.value = [];
    error.value = "";
    notice.value = "";
    void refresh();
  },
);
watch(
  () => props.list?.version,
  () => {
    if (!busy.value) void refresh();
  },
);
</script>

<template>
  <section class="carry" aria-label="同行背负">
    <header v-if="!requestOnly" class="carry__head">
      <h2>协作</h2>
      <NuxtLink v-if="list" to="/carry" class="btn btn--link"
        >全部协作 ↗</NuxtLink
      ><button
        class="btn btn--link"
        :disabled="loading || busy"
        @click="refresh"
      >
        刷新
      </button>
    </header>
    <p v-if="!session.user.value?.email" class="carry__muted">
      用邮箱登录后，可以请求同行者背负装备并接收请求。<button
        class="btn btn--link"
        @click="account.open"
      >
        登录
      </button>
    </p>
    <template v-else>
      <div
        v-if="
          !requestOnly &&
          ((list && outgoing.some((r) => !r.cancelled)) || packing.length)
        "
        class="carry__summary"
      >
        <span v-if="list"
          >清单装备 <b>{{ weight(computeTotals(list).totalMg) }}</b></span
        >
        <span v-if="list"
          >对方已接手 <b>−{{ weight(transferred) }}</b></span
        >
        <span
          >替同行者背 <b>{{ weight(inboundWeight) }}</b></span
        >
        <span
          >{{ list ? "调整后总携带" : "已接受的背负" }}
          <b>{{ weight(netWeight) }}</b></span
        >
      </div>
      <p
        v-if="
          !requestOnly &&
          list &&
          (outgoing.some((r) => !r.cancelled) || packing.length)
        "
        class="carry__muted"
      >
        上方图表仍统计原始清单；这里单独计算已确认的分担（含穿戴）。待确认的请求不转移重量。
      </p>
      <button
        v-if="list && !inlineSelection"
        class="btn"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? "收起选择" : "请求同行者帮忙背" }}
      </button>
      <BaseModal
        :open="expanded && !!list"
        label="请求帮忙背负"
        @close="expanded = false"
      >
        <form v-if="list" class="carry__form" @submit.prevent="create">
          <div class="carry__head">
            <h3>请求帮忙背负</h3>
            <button
              class="btn btn--link"
              type="button"
              @click="expanded = false"
            >
              关闭
            </button>
          </div>
          <label v-if="members.length"
            >同行者<select @change="chooseMember">
              <option value="">选择已保存的成员，或填写新成员</option>
              <option
                v-for="member in members"
                :key="member.email"
                :value="member.email"
              >
                {{ member.name }} · {{ member.email }}
              </option>
            </select></label
          >
          <div class="carry__fields">
            <label
              >对方姓名<input
                v-model="name"
                required
                maxlength="60"
                placeholder="Molly" /></label
            ><label
              >登录邮箱<input
                v-model="email"
                type="email"
                required
                autocomplete="email"
                placeholder="对方之后用此邮箱登录"
            /></label>
          </div>
          <label
            >附言<textarea
              v-model="note"
              maxlength="1000"
              rows="2"
              placeholder="例如：帐篷我会背，地垫想请你背。"
            ></textarea>
          </label>
          <input
            v-if="!inlineSelection"
            v-model="query"
            aria-label="搜索待分享装备"
            placeholder="搜索装备…"
            type="search"
          />
          <p v-if="inlineSelection" class="carry__muted">
            已从装备清单选择 {{ roots.length }} 件／套 ·
            {{ weight(selectionWeight) }}。关闭窗口可继续调整选择。
          </p>
          <div v-if="inlineSelection" class="carry__selection-preview">
            <span v-for="id in roots" :key="id">{{
              list.items.find((i) => i.id === id)?.name || "未命名装备"
            }}</span>
          </div>
          <div v-else class="carry__picker">
            <label
              v-for="item in matches"
              :key="item.id"
              :class="{ carry__child: item.parentId }"
              ><input
                v-model="selected"
                type="checkbox"
                :value="item.id"
              /><span
                >{{
                  [item.brand, item.name, item.variant]
                    .filter(Boolean)
                    .join(" ") || "未命名装备"
                }}<small v-if="list.items.some((i) => i.parentId === item.id)"
                  >整套 · 包含散件</small
                ></span
              ><span>{{
                weight(carryWeight(carryGear(list, item.id)))
              }}</span></label
            >
          </div>
          <p class="carry__muted">
            仅分享勾选的装备及附言。选择整套时自动包含子项，父子同时勾选只计一次。对方不需要提前注册。
          </p>
          <label class="carry__notify"
            ><input
              v-model="notify"
              type="checkbox"
            />同时发送一封提醒邮件</label
          >
          <button
            class="btn"
            type="submit"
            :disabled="busy || !roots.length || ready === false"
          >
            保存背负请求 · {{ weight(selectionWeight) }}
          </button>
          <p v-if="error" class="carry__error" role="alert">{{ error }}</p>
        </form>
      </BaseModal>
      <p v-if="error" class="carry__error" role="alert">{{ error }}</p>
      <p v-if="notice" class="carry__notice" role="status">{{ notice }}</p>
      <details v-if="!requestOnly" class="carry__requests">
        <summary>我的同行者 · {{ members.length }}</summary>
        <p class="carry__muted">
          姓名和邮箱仅保存在你的账户中，可以跨设备复用。
        </p>
        <div v-for="member in members" :key="member.email" class="carry__head">
          <span>{{ member.name }} · {{ member.email }}</span
          ><button class="btn btn--link" @click="removeMember(member.email)">
            移除
          </button>
        </div>
        <form class="carry__fields" @submit.prevent="saveMember">
          <label
            >姓名<input v-model="memberName" maxlength="60" required /></label
          ><label
            >邮箱<input v-model="memberEmail" type="email" required /></label
          ><button class="btn" type="submit">保存成员</button>
        </form>
      </details>
      <div v-if="!requestOnly && incoming.length" class="carry__requests">
        <h3>收到的请求</h3>
        <details v-for="r in incoming" :key="r.id" @toggle="edit(r)">
          <summary>
            <span
              >{{ r.senderName }} → 我 <small>{{ r.tripTitle }}</small></span
            ><span>{{ carrySummary(r) }} · {{weight(r.units.reduce((n,u)=>n+carryWeight(u.gear),0))}}</span>
          </summary>
          <p v-if="r.note" class="carry__context">{{ r.note }}</p>
          <p v-if="r.reply" class="carry__muted">我的答复：{{ r.reply }}</p>
          <template v-if="drafts[r.id] && !r.cancelled">
            <div
              v-for="u in drafts[r.id]!.units"
              :key="u.rootId"
              class="carry__unit"
            >
              <div class="carry__unithead">
                <strong>{{ u.gear[0]?.name || "已删除的装备" }}</strong
                ><span>{{ weight(carryWeight(u.gear)) }}</span
                ><select
                  v-model="u.decision"
                  :aria-label="`${u.gear[0]?.name} 背负决定`"
                >
                  <option value="pending">待决定</option>
                  <option value="accepted" :disabled="u.unavailable">
                    愿意背
                  </option>
                  <option value="declined">这次不背</option>
                </select>
              </div>
              <p v-if="u.needsReview" class="carry__notice">
                装备内容或数量已变化；保存答复后才会重新计入背负。
              </p>
              <label class="carry__group"
                >整套放到<input
                  :value="u.groups[u.rootId] || '替别人背'"
                  list="carry-groups"
                  :aria-label="`${u.gear[0]?.name} 的分组`"
                  @input="
                    setKitGroup(u, ($event.target as HTMLInputElement).value)
                  "
              /></label>
              <div
                v-for="g in u.gear"
                :key="g.id"
                class="carry__detail"
                :class="{ carry__child: g.parentId }"
              >
                <span
                  >{{ g.name }} ×{{ g.qty
                  }}<small v-if="g.note">{{ g.note }}</small></span
                ><span>{{ weight(g.weightMg * g.qty) }}</span
                ><input
                  :value="u.groups[g.id] || '替别人背'"
                  list="carry-groups"
                  :aria-label="`${g.name} 单独分组`"
                  @input="
                    u.groups[g.id] = ($event.target as HTMLInputElement).value
                  "
                />
              </div>
            </div>
            <label
              >回复<textarea
                v-model="drafts[r.id]!.reply"
                rows="2"
                maxlength="1000"
                placeholder="可以，地垫我放背包外侧。"
              ></textarea>
            </label>
            <label class="carry__group"
              >加入我的清单<select
                v-model="drafts[r.id]!.destinationCode"
                :disabled="busy"
              >
                <option :value="undefined">仅在背负清单中显示</option>
                <option
                  v-for="own in claimed.lists.value"
                  :key="own.shareCode"
                  :value="own.shareCode"
                >
                  {{ own.title || "未命名清单" }}
                </option>
              </select></label
            >
            <button
              v-if="list && r.destinationCode !== list.shareCode"
              class="btn btn--link"
              :disabled="busy"
              @click="drafts[r.id]!.destinationCode = list.shareCode"
            >
              加入当前清单
            </button>
            <button
              class="btn"
              :disabled="busy"
              @click="mutate(drafts[r.id]!, 'reply')"
            >
              保存答复
            </button>
          </template>
        </details>
      </div>
      <div v-if="!requestOnly && outgoing.length" class="carry__requests">
        <h3>发出的请求</h3>
        <details v-for="r in outgoing" :key="r.id">
          <summary>
            <span
              >我 → {{ r.recipientName }}<small>{{ r.tripTitle }}</small></span
            ><span>{{ carrySummary(r) }} · {{weight(r.units.reduce((n,u)=>n+carryWeight(u.gear),0))}}</span>
          </summary>
          <p class="carry__muted">
            {{ r.recipientEmail }}
            <button class="btn btn--link" @click="copyInbox">
              复制收件箱链接
            </button>
          </p>
          <p v-if="r.note" class="carry__context">{{ r.note }}</p>
          <div v-for="u in r.units" :key="u.rootId" class="carry__unithead">
            <span>{{ u.gear[0]?.name || "已删除" }}</span
            ><span>{{ weight(carryWeight(u.gear)) }}</span
            ><span>{{ label(u) }}</span>
          </div>
          <p v-if="r.reply" class="carry__context">
            {{ r.recipientName }}：{{ r.reply }}
          </p>
          <button
            v-if="!r.cancelled"
            class="btn btn--link"
            :disabled="busy"
            @click="mutate(r, 'cancel')"
          >
            取消请求
          </button>
        </details>
      </div>
      <div v-if="(!requestOnly || packingOnly) && packing.length" class="carry__packing">
        <h3>替同行者背 · 打包清单</h3>
        <p class="carry__muted">
          分组、顺序和勾选只影响你的视图；重量随来源更新，不会复制成你的装备。
        </p>
        <div v-for="group in groups" :key="group.name" class="carry__packgroup">
          <h4>
            {{ group.name }}
            <span>{{
              weight(
                group.rows.reduce(
                  (n, r) => n + r.gear.weightMg * r.gear.qty,
                  0,
                ),
              )
            }}</span>
          </h4>
          <div
            v-for="row in group.rows"
            :key="row.request.id + row.gear.id"
            class="carry__packrow"
            :class="{ carry__child: row.gear.parentId }"
          >
            <input
              type="checkbox"
              :checked="
                row.gear.id === row.unit.rootId && row.unit.gear.length > 1
                  ? row.unit.gear
                      .filter((g) => g.id !== row.unit.rootId || g.weightMg > 0)
                      .every((g) => row.unit.packed[g.id])
                  : row.unit.packed[row.gear.id]
              "
              :aria-label="`${row.gear.name} 已打包`"
              :disabled="busy"
              @change="
                packedRow(row, ($event.target as HTMLInputElement).checked)
              "
            />
            <span
              >{{ row.gear.name }}
              <small
                >{{ row.request.senderName }} 的装备{{
                  row.kit ? " · " + row.kit : ""
                }}
                · ×{{ row.gear.qty }}</small
              ></span
            >
            <span>{{
              !row.gear.parentId &&
              row.unit.gear.length > 1 &&
              row.gear.weightMg === 0
                ? "套装"
                : weight(row.gear.weightMg * row.gear.qty)
            }}</span>
            <input
              :value="row.group"
              list="carry-groups"
              :aria-label="`${row.gear.name} 分组`"
              :disabled="busy"
              @blur="groupRow(row, ($event.target as HTMLInputElement).value)"
            />
            <div class="carry__moves">
              <button
                class="btn btn--link"
                :aria-label="`${row.gear.name} 上移`"
                :disabled="busy"
                @click="move(row, -1)"
              >
                ↑</button
              ><button
                class="btn btn--link"
                :aria-label="`${row.gear.name} 下移`"
                :disabled="busy"
                @click="move(row, 1)"
              >
                ↓
              </button>
            </div>
          </div>
        </div>
      </div>
      <p v-if="!list && !loading && !requests.length" class="carry__muted">
        还没有背负请求。让同行者在自己的清单里选择装备，并填写你的登录邮箱。
      </p>
      <datalist id="carry-groups">
        <option v-for="g in knownGroups" :key="g" :value="g" />
      </datalist>
    </template>
  </section>
</template>

<style scoped>
.carry {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  margin-block: 16px;
  font-size: 13px;
  color: var(--ink);
  min-width: 0;
}
.carry__head,
.carry__summary,
.carry__unithead {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.carry__head h2 {
  font-size: 14px;
  margin: 0;
  flex: 1;
}
.carry h3 {
  font-size: 12px;
  color: var(--ink-2);
  margin: 18px 0 6px;
}
.carry h4 {
  font-size: 13px;
  margin: 12px 0 0;
  padding-block: 8px;
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
}
.carry__summary {
  margin: 12px 0;
  gap: 8px 20px;
}
.carry__summary b {
  font-variant-numeric: tabular-nums;
  margin-left: 6px;
}
.carry__muted,
small {
  color: var(--ink-2);
  font-size: 12px;
  line-height: 1.5;
}
.carry small {
  display: block;
  font-style: normal;
}
.carry__form {
  display: grid;
  gap: 10px;
  margin-top: 12px;
}
.carry__notify {
  display: flex !important;
  align-items: center;
  gap: 8px !important;
}
.carry__fields {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 12px;
}
.carry label {
  display: grid;
  gap: 4px;
}
.carry input:not([type="checkbox"]),
.carry textarea,
.carry select {
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--paper);
  color: var(--ink);
  font: inherit;
  padding: 7px;
  min-width: 0;
  width: 100%;
}
.carry input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--ink);
}
.carry__selection-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.carry__selection-preview span {
  padding: 3px 8px;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 4px;
  font-size: 12px;
}
.carry__picker {
  max-height: 300px;
  overflow: auto;
  border-block: 1px solid var(--line);
}
.carry__picker label {
  display: grid;
  grid-template-columns: 20px 1fr auto;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}
.carry__child {
  padding-left: 20px !important;
  border-left: 1px solid var(--line);
}
.carry details {
  border-bottom: 1px solid var(--line);
  padding: 10px 0;
}
.carry summary {
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  list-style: revert;
}
.carry summary > span:last-child {
  font-size: 12px;
  color: var(--ink-2);
}
.carry__context {
  white-space: pre-wrap;
  line-height: 1.5;
}
.carry__unit {
  padding-block: 10px;
  border-top: 1px solid var(--line);
}
.carry__unithead {
  justify-content: space-between;
}
.carry__unithead select {
  width: 110px;
}
.carry__group {
  display: flex !important;
  align-items: center;
  gap: 12px !important;
  margin-block: 8px;
}
.carry__group input,
.carry__group select {
  max-width: 220px;
}
.carry__detail {
  display: grid;
  grid-template-columns: 1fr 85px 130px;
  gap: 12px;
  padding: 6px 0;
  align-items: center;
}
.carry__packrow {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) 80px 120px 64px;
  gap: 10px;
  align-items: center;
  min-height: 48px;
  border-bottom: 1px solid var(--line);
  padding-block: 6px;
}
.carry__packrow > span {
  overflow-wrap: anywhere;
}
.carry__packrow > span:nth-child(3) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.carry__moves {
  display: flex;
}
.carry__moves .btn {
  padding: 5px;
  min-width: 28px;
}
.carry__error {
  color: #b64b35;
}
.carry__notice {
  font-size: 12px;
  line-height: 1.5;
  padding: 8px;
  background: var(--paper-2, var(--paper));
  border-left: 2px solid var(--ink-2);
}
@media (max-width: 600px) {
  .carry {
    padding: 10px;
  }
  .carry__fields {
    grid-template-columns: 1fr;
  }
  .carry__detail {
    grid-template-columns: 1fr 65px;
  }
  .carry__detail > input {
    grid-column: 1/-1;
  }
  .carry__packrow {
    grid-template-columns: 20px minmax(0, 1fr) 65px;
  }
  .carry__packrow > input:not([type="checkbox"]) {
    grid-column: 2;
    max-width: 160px;
  }
  .carry__moves {
    grid-column: 3;
  }
  .carry .btn,
  .carry select {
    min-height: 40px;
  }
  .carry summary {
    align-items: flex-start;
  }
}
</style>

<style scoped>
.carry__form .carry__head {display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;}
.carry__form .carry__head h3 {font-size:18px;font-weight:600;}
</style>
