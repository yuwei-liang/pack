<script setup lang="ts">
const route = useRoute();
const links = [
  {
    to: "/trips",
    label: "旅行清单",
    active: (path: string) =>
      path === "/" || path.startsWith("/e") || path === "/trips",
  },
  { to: "/gear", label: "装备库", active: (path: string) => path === "/gear" },
  { to: "/carry", label: "协作", active: (path: string) => path === "/carry" },
];
</script>
<template>
  <nav class="pack-nav" aria-label="全局导航">
    <NuxtLink to="/trips" class="pack-nav__brand">PACK</NuxtLink
    ><NuxtLink
      v-for="link in links"
      :key="link.to"
      :to="link.to"
      :aria-current="link.active(route.path) ? 'page' : undefined"
      >{{ link.label }}</NuxtLink
    >
  </nav>
</template>
<style scoped>
.pack-nav {
  display: flex;
  gap: 18px;
  align-items: center;
  white-space: nowrap;
  font-size: 13px;
}
.pack-nav a {
  color: var(--ink-3);
  text-decoration: none;
  padding-block: 7px;
}
.pack-nav a[aria-current="page"] {
  color: var(--ink);
  border-bottom: 2px solid var(--ink);
}
.pack-nav .pack-nav__brand {
  font-size: 15px;
  font-weight: 700;
  color: var(--ink);
  letter-spacing: 1px;
}
@media (max-width: 600px) {
  .pack-nav {
    gap: 12px;
    font-size: 12px;
  }
  .pack-nav .pack-nav__brand {
    font-size: 13px;
  }
}
</style>
