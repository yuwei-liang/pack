<script setup lang="ts">
// The bare address: resume the list you opened last, or — with nothing to resume —
// say what this is. The resume is app/middleware/resume.ts — a named middleware, so
// the routes table needn't import this page to know about it — and it runs before
// this page renders. What's left to render is a first visit (or a signed-in account
// with no list yet), and a first visit used to land on an empty draft with nothing
// on the page saying what the tool was or that it needs no account. Starting a list
// is one click away at /e, which keeps meaning "new".
import { resumeHere } from "~/composables/useResumed";

definePageMeta({ layout: false, middleware: "resume" });

// Prerendered, so the intro is in the HTML before any script runs — which is also
// what a returning visitor would see for a beat before the resume redirect lands.
// This runs first, in <head>, and hides the intro when this browser holds a list to
// go back to (the same two sources resumeHere ranks: the registry's edit links, and
// a signed-in account's opens). Read from storage by hand because nothing of the app
// has loaded yet; a wrong guess either way costs one blank beat or one flash, never
// a wrong page — the middleware is still what decides.
const HIDE_WHILE_RESUMING = `try{var r=false,l=JSON.parse(localStorage.getItem("gear.mylists.v1")||"[]");if(Array.isArray(l))r=l.some(function(e){return e&&e.editToken});if(!r&&/(?:^|; )mh_signed_in=1/.test(document.cookie))for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i)||"";if(k.indexOf("gear.claimed.opens.v2")===0&&(localStorage.getItem(k)||"{}")!=="{}"){r=true;break}}if(r)document.documentElement.classList.add("home-resuming")}catch(e){}`;

useHead({
  title: "Pack · 称一称你的背包",
  meta: [
    {
      name: "description",
      content: "把要带的装备列成清单，自动算出总重和底重，分享给同伴。不用注册，打开就能用。",
    },
  ],
  script: [{ innerHTML: HIDE_WHILE_RESUMING, tagPosition: "head" }],
});

// The page can still mount with a resume pending (a `/?utm_source=…` link hydrates
// as `/` before the middleware moves it on), so the intro stays hidden then too.
onMounted(() => {
  if (!resumeHere()) document.documentElement.classList.remove("home-resuming");
});

// Signed in: the second button goes to your lists rather than to the sign-in. Set
// on mount, like AccountMenu, so the prerendered (signed-out) shape hydrates clean.
const { presence } = useSession();
const signedIn = ref(false);
onMounted(() => (signedIn.value = presence.value !== "signedOut"));
watch(presence, (p) => (signedIn.value = p !== "signedOut"));
const { open: openAccount } = useAccountModal();
</script>

<template>
  <div class="home">
    <SiteTopbar />

    <!-- one reading column, the hero included: .prose centres itself in the page,
         and a hero outside it sat flush left of the text below it -->
    <main id="main-content" tabindex="-1" class="wrap page">
      <div class="prose">
        <section class="home__hero">
          <h1>称一称你的背包</h1>
          <p class="home__lede">
            把要带的装备列成清单，Pack 帮你算出总重、底重，和每个人背多少。不用注册，打开就能用。
          </p>
          <div class="home__cta">
            <NuxtLink to="/e" class="btn btn--primary">开始一份清单</NuxtLink>
            <NuxtLink v-if="signedIn" to="/trips" class="btn">我的旅行清单</NuxtLink>
            <button v-else type="button" class="btn" @click="openAccount">注册 / 登录</button>
          </div>
        </section>

        <h2>怎么用</h2>
        <ul>
          <li>
            <strong>新建清单。</strong>点「开始一份清单」，直接往里加装备。重量可以自己填，也可以从带出处的装备目录里搜。
          </li>
          <li>
            <strong>看重量。</strong>总重、底重（不算身上穿的和吃喝的）分开算；按天排行程，看每天出发时背多重。
          </li>
          <li>
            <strong>分享给同伴。</strong>每份清单有两个链接：编辑链接自己留着，只读链接发给别人看。
          </li>
        </ul>

        <h2>要不要注册？</h2>
        <div class="home__modes">
          <div>
            <h3>不注册</h3>
            <p>
              清单只存在这台设备上：浏览器替你记住它的编辑链接。换了设备、或清掉浏览器数据，就只能靠你自己存下的编辑链接找回。
            </p>
          </div>
          <div>
            <h3>注册之后</h3>
            <p>
              用通行密钥或邮件链接登录，不用设密码。清单跟着账号走，哪台设备都能打开；装备库记住你有的装备，下次一点就加进清单；还能和同伴协作分装备。
            </p>
          </div>
        </div>
        <p class="t-muted">
          先不注册也没关系：在这台设备上建的清单，之后注册登录时会自动归到你的账号里。
        </p>

        <p><NuxtLink to="/about">关于 Pack</NuxtLink></p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.home__hero {
  padding-block: var(--space-4) var(--space-3);
}
.home__hero h1 {
  margin: 0;
  font-size: clamp(1.75rem, 1.2rem + 2.4vw, 2.5rem);
  line-height: 1.2;
}
.home__lede {
  margin: var(--space-3) 0 0;
  font-size: 1.0625rem;
  color: var(--ink-2);
  max-width: 34em;
}
.home__cta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-5);
}
.home__modes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}
.home__modes h3 {
  margin-top: 0;
}
@media (max-width: 600px) {
  .home__modes {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

<style>
/* set by the <head> script above, before first paint */
.home-resuming .home {
  visibility: hidden;
}
</style>
