<script setup lang="ts">
useHead({ title: '家庭登录 · Mahonia', meta: [{name:'robots',content:'noindex'}] });
const name = ref('molly');
const password = ref('');
const invite = ref('');
const error = ref('');
const busy = ref(false);
onMounted(() => {
  const params = new URLSearchParams(location.hash.slice(1));
  invite.value = params.get('invite') ?? '';
  name.value = params.get('name') ?? 'molly';
  history.replaceState(null,'',location.pathname);
});
async function login() {
  busy.value=true; error.value='';
  try {
    await $fetch('/api/auth/household',{method:'POST',body:{name:name.value,password:password.value,invite:invite.value}});
    location.assign('/household-home');
  } catch { error.value='登录失败，请检查密码或邀请链接。密码至少 12 个字符。'; }
  finally {busy.value=false;}
}
</script>
<template>
  <main class="household wrap">
    <h1>家庭装备清单</h1>
    <p>{{ invite ? '设置你的独立账号密码。' : '登录你的账号，查看自己的清单和装备库。' }}</p>
    <form @submit.prevent="login">
      <label>账号<select v-model="name" class="field"><option value="molly">Molly</option><option value="yuwei">Yuwei</option></select></label>
      <label>密码<input v-model="password" class="field" type="password" minlength="12" maxlength="128" :autocomplete="invite ? 'new-password' : 'current-password'" required /></label>
      <p v-if="error" role="alert">{{ error }}</p>
      <button class="btn btn--primary" :disabled="busy">{{ busy ? '处理中…' : invite ? '设置密码并登录' : '登录' }}</button>
    </form>
  </main>
</template>
<style scoped>
.household { max-width:420px; padding-top:48px; } form,label { display:flex; flex-direction:column; gap:10px; } form {gap:20px;} input,select{width:100%;} h1{font-size:24px;}
</style>
