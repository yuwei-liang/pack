<script setup lang="ts">
import { mergeSwitcherRows } from "~~/shared/switcher";
const session = useSession(),
  my = useMyLists(),
  claimed = useClaimedLists();
const query = ref("");
const trips = computed(() =>
  mergeSwitcherRows(my.entries.value, claimed.lists.value).filter((r) =>
    r.title.toLowerCase().includes(query.value.toLowerCase()),
  ),
);
// Where each list lives, said out loud: a list this browser holds the edit link for
// but the account doesn't is reachable from this device only. Signed out, that is
// every row (sign-out empties the account's half), so the page says it once above
// the rows instead of on each; signed in, the rows the account lacks are tagged.
const inAccount = computed(() => new Set(claimed.lists.value.map((l) => l.shareCode)));
// (a legacy row with no share code can't be matched here, so it isn't tagged)
const deviceOnly = (r: { shareCode: string }) => !!r.shareCode && !inAccount.value.has(r.shareCode);
onMounted(async () => {
  await session.refresh();
  if (session.signedIn.value) await claimed.refresh();
});
useHead({
  title: "旅行清单 | Pack",
  meta: [{ name: "robots", content: "noindex" }],
});
</script>
<template>
  <div>
    <SiteTopbar />
    <main id="main-content" tabindex="-1" class="wrap trips-page">
      <header>
        <h1>旅行清单</h1>
        <NuxtLink to="/e" class="btn">＋ 新建旅行</NuxtLink>
      </header>
      <SearchField
        v-model="query"
        placeholder="搜索旅行…"
        label="搜索旅行清单"
      /><ClientOnly
        ><div class="trips-page__rows">
          <p v-if="session.presence.value === 'signedOut' && trips.length" class="trips-page__where">
            这些清单只存在这台设备上，靠浏览器记住的编辑链接打开。登录后会自动归到你的账号，在别的设备上也能打开。
          </p>
          <NuxtLink v-for="trip in trips" :key="trip.key" :to="trip.to"
            ><span class="trips-page__title"
              >{{ trip.title || "未命名旅行" }}<em
                v-if="session.signedIn.value && deviceOnly(trip)"
                class="trips-page__local"
                title="这份清单不在你的账号里，只能在这台设备上打开"
                >仅本机</em
              ></span
            ><span>打开 ›</span></NuxtLink
          >
          <p v-if="!trips.length">
            {{
              query
                ? "没有匹配的旅行"
                : "还没有旅行清单。可以新建一份，或用原有编辑链接打开。"
            }}
          </p>
        </div>
        <template #fallback><p>正在加载旅行清单…</p></template></ClientOnly
      >
    </main>
  </div>
</template>
<style scoped>
.trips-page {
  max-width: 960px;
  padding-top: 24px;
}
.trips-page header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.trips-page h1 {
  font-size: 22px;
}
.trips-page__rows {
  margin-top: 16px;
}
.trips-page__rows > a {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 15px 4px;
  border-bottom: 1px solid var(--line);
  color: var(--ink);
  text-decoration: none;
  font-size: 15px;
}
.trips-page__rows > a > span:last-child {
  font-size: 13px;
  color: var(--ink-3);
}
.trips-page__where {
  margin: 0 0 4px;
  font-size: 13px;
  color: var(--ink-3);
}
.trips-page__local {
  margin-left: 8px;
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 12px;
  font-style: normal;
  color: var(--ink-3);
  vertical-align: 1px;
}
</style>
