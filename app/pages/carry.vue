<script setup lang="ts">
useHead({
  title: "协作 | Pack",
  meta: [{ name: "robots", content: "noindex" }],
});
</script>
<template>
  <div>
    <SiteTopbar />
    <main id="main-content" tabindex="-1" class="wrap carry-page">
      <ClientOnly
        ><CarryWorkspace /><template #fallback
          ><p>正在加载背负清单…</p></template
        ></ClientOnly
      >
    </main>
  </div>
</template>
<style scoped>
.carry-page {
  max-width: 900px;
  padding-top: 16px;
}
</style>
