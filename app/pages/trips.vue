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
          <NuxtLink v-for="trip in trips" :key="trip.key" :to="trip.to"
            >{{ trip.title || "未命名旅行" }}<span>打开 ›</span></NuxtLink
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
.trips-page__rows span {
  font-size: 13px;
  color: var(--ink-3);
}
</style>
