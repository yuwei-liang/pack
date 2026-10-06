<script setup lang="ts">
useHead({title:'我的旅行 · Mahonia',meta:[{name:'robots',content:'noindex'}]});
const lists=ref<{shareCode:string;title:string}[]>([]);
const signedIn=ref(false);const error=ref('');const title=ref('');const busy=ref(false);
onMounted(async()=>{try{const me=await $fetch<{user:unknown}>('/api/auth/me');if(!me.user){location.assign('/household');return;}signedIn.value=true;const res=await $fetch<{lists:typeof lists.value}>('/api/lists/claimed');lists.value=res.lists;}catch{error.value='加载失败，请刷新重试。';}});
async function create(){busy.value=true;try{const r=await $fetch<{editToken:string;snapshot:{shareCode:string}}>('/api/lists/create',{method:'POST',body:{title:title.value.trim()||'我的旅行'}});await $fetch('/api/lists/claim',{method:'POST',body:{editTokens:[r.editToken]}});location.assign(`/e/${r.snapshot.shareCode}`);}catch{error.value='创建失败，请重试。';}finally{busy.value=false;}}
</script>
<template><main class="wrap household-home"><h1>我的旅行</h1><div v-if="signedIn"><p><NuxtLink to="/gear">我的装备库</NuxtLink> · <NuxtLink to="/account">账号</NuxtLink></p><ul><li v-for="list in lists" :key="list.shareCode"><NuxtLink :to="`/e/${list.shareCode}`">{{ list.title || '未命名清单' }}</NuxtLink></li></ul><p v-if="!lists.length">还没有清单，创建你的第一份旅行清单。</p><form @submit.prevent="create"><input v-model="title" class="field" placeholder="旅行名称" aria-label="旅行名称"/><button class="btn btn--primary" :disabled="busy">新建清单</button></form></div><p v-if="error" role="alert">{{error}}</p></main></template>
<style scoped>.household-home{max-width:720px;padding-top:32px;}h1{font-size:24px;}form{display:flex;gap:12px;margin-top:24px;}li{padding-block:8px;}</style>
