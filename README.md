# Pack

Yuwei 和 Molly 的装备与打包应用，基于 [Mahonia](https://github.com/ryankiley/mahonia)。

- 正式地址：https://pack.yuweiliang.com
- 代码目录：`~/workspaces/pack`（2026-10-06 从 `life/travel/mahonia-trial` 迁出）
- 本地启动：`npm run dev -- --port 18767`
- 部署及数据边界：见 [DEPLOYMENT.md](./DEPLOYMENT.md)
- 原始项目说明和 MIT 许可证保留在下面及 `LICENSE`。代码仓库：[yuwei-liang/pack](https://github.com/yuwei-liang/pack)。`origin` 是个人 fork，`upstream` 是 Mahonia。

## 同行背负

在旅行清单的装备区域点「选择物品请人背」，直接在装备行勾选，再点「发起背负请求」，填对方登录邮箱和附言，保存请求。选择套装包含散件，选择单件只分享单件。对方可以尚未注册。

对方用相同邮箱登录 [请求收件箱](https://pack.yuweiliang.com/carry)，逐项接受或婉拒；接受时可加入自己的旅行清单。分组、排序和打包勾选独立保存，套装可整体移动，也可拆分散件到不同分组。来源清单与装备库不会被复制或改写。

同行背负面板显示确认分担后的总携带：原清单重量 − 已被接手装备 + 替同行者背的装备。原有图表统计原清单装备；待确认、已取消、已删除或需要重新确认的装备不会转移负重。内容/数量变化须重新确认，重量修正同步更新。

勾选「同时发送一封提醒邮件」才发送 Resend 提醒；邮件提供收件箱入口，不提供来源清单或登录凭证。不勾选时可复制收件箱链接。账户导出包含协作记录；关闭账户会清除相关请求。

---

# Mahonia

A gear-list and pack-weight tracker for hikers. Make a packing list, see what it weighs,
share it.

Lists need no sign-up: one is yours the moment you start typing, held by a private
unguessable link. The **gear vault** is the one part that asks for an account, because
"the gear I own" has to follow you across devices rather than living in one browser.

## What it does

- **Weigh a pack.** Base, worn and consumable totals, with the worn split (three pairs of
  socks, one on your feet) and a carried figure. Weights are optional — a list with none
  keeps its totals quiet.
- **A curated gear catalog** behind the autocomplete, cited and correctable, with every
  value overridable per row.
- **Per-row units.** Type `32.5 oz` on a gram list and that row keeps ounces while the
  total stays in grams.
- **Calories** on consumables, totalled for the list.
- **Trip dates**, as calendar dates — no time, no timezone, so a trip doesn't shift when
  you fly.
- **Share two ways:** a read-only link, and an edit link for co-planning. Either can be
  replaced if it gets out.
- **Packing mode** — the same list as a checklist, for the night before.
- **A gear vault** that fills itself as you build, so your kit is one pick away next time.
- **Import** from LighterPack (share link or CSV) or a JSON backup; **export** as CSV,
  JSON or Markdown.
- **Recovery points**, so an accidental delete is undoable well after the toast.

## Run locally

Requires **Node 24** (the pinned version — see `.nvmrc`).

```bash
npm install
npm run seed   # load the gear catalog into a local database
npm run dev    # http://localhost:3000
```

With no environment variables set, the app runs fully on your machine against a local
[PGlite](https://github.com/electric-sql/pglite) database. Copy `.env.example` to `.env` to
point at a real Postgres ([Neon](https://neon.tech)) and Redis ([Upstash](https://upstash.com))
for a production deploy.

Anything that would leave the machine degrades to the console instead of being skipped, so
a fresh checkout is a working app rather than a broken one:

| Unset variable | What happens locally |
| --- | --- |
| `RESEND_API_KEY` | Sign-in links print to the server console instead of being emailed. |
| `GITHUB_FEEDBACK_TOKEN` / `_REPO` | "Send feedback" (in the editor's actions menu) prints to the console and reports back that it wasn't filed. |

Both fail **loudly in production** rather than quietly accepting input that goes nowhere.

## Stack

[Nuxt 4](https://nuxt.com) · Vue 3 · TypeScript · [Drizzle ORM](https://orm.drizzle.team) ·
deployed on [Vercel](https://vercel.com).

## MCP connector

The app serves a remote MCP server at `/mcp`, so an AI assistant can be handed
`https://mahonia.app/mcp` as a connector with nothing to install and no sign-in. Seven
tools: read a shared list as data or Markdown, search the catalog, fetch one product's
variants, and, holding an edit link, make a list, add rows and set the trip's dates and
trail. A share code is the read capability and the edit link's fragment token the write
one, hashed on arrival and passed only as a tool argument, so nothing new is trusted. The
transport is stateless JSON-RPC over POST (MCP revisions 2025-06-18 and 2025-11-25, no
sessions, no event stream, GET answers 405), hand-rolled in `server/routes/mcp.post.ts`
with the tools in `server/utils/mcp.ts`; both files carry the reasoning. My Gear is
deliberately out of reach: it would need an account token, which is a separate decision.

Add it to a client:

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=mahonia&config=eyJ1cmwiOiJodHRwczovL21haG9uaWEuYXBwL21jcCJ9)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=mahonia&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmahonia.app%2Fmcp%22%7D)

- **Claude** (claude.ai, Desktop, mobile): [add Mahonia as a connector](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Mahonia&connectorUrl=https%3A%2F%2Fmahonia.app%2Fmcp)
  and choose "No sign-in". Connectors added there are available in Claude Code too.
- **Claude Code:** `claude mcp add --transport http --scope user mahonia https://mahonia.app/mcp`
- **Gemini CLI:** `gemini mcp add --transport http mahonia https://mahonia.app/mcp`
- **ChatGPT:** Settings, Developer mode, add `https://mahonia.app/mcp` with "No Authentication".
- **Anything that reads an `mcp.json`:** `{"mcpServers":{"mahonia":{"url":"https://mahonia.app/mcp"}}}`
- **A client that only speaks stdio:** bridge with `npx mcp-remote https://mahonia.app/mcp`.

The server is listed in the [official MCP registry](https://registry.modelcontextprotocol.io)
as `app.mahonia/mahonia`; [`server.json`](server.json) is the listing, published with
`mcp-publisher` under the domain's DNS proof.

## Changelog

The changelog is [GitHub Releases](https://github.com/ryankiley/mahonia/releases): one release
per day that ships something, tagged by date (`v2026.09.12`), cut by a workflow from the entries
below. When a change is user-facing, add a plain one-sentence entry as part of the same PR:

```bash
npm run changelog -- --added "Sort folders by weight."
npm run changelog -- --fixed "…" --changed "…"
```

Entries are grouped Added / Changed / Fixed and describe the observable change, not the
implementation.

Each run writes its own file under `content/changelog.d/`, so entries from PRs open at the
same time never collide — [`content/changelog.json`](content/changelog.json) is the settled
archive, and `npm run changelog:compact` folds fragments into it now and then. Once a day is
over (Pacific), `.github/workflows/releases.yml` turns it into a release; a late entry updates
its day's notes.

A PR comment reminds any user-facing PR that's missing an entry — but nothing auto-fills it,
so the entry is always hand-written (plain, curated prose). If a PR merges
without one, that day's release just omits the change until it's backfilled. For non-user-facing work,
prefix the PR title (`refactor:`, `chore:`, `ci:`, `test:`, `docs:`, `build:`) or label it
**`skip-changelog`** — `perf:` and `style:` don't count, since both are things a visitor notices.

## License

Code is [MIT](LICENSE). The gear catalog data under `seed/` is licensed separately — see
[`seed/LICENSE.md`](seed/LICENSE.md).

Third-party notices for the libraries bundled into the client are in
[`public/licenses.txt`](public/licenses.txt), served at `/licenses.txt`. The file exists
because Mahonia bundles its dependencies instead of loading them from a CDN (a CDN
`<script>` could read a list's edit token out of `location.hash`), which makes serving the
site a redistribution of that code — and the minifier strips the banner comments those
libraries ship their copyright in. Add an entry when a dependency's code starts reaching
the browser; server-only packages aren't redistributed and aren't listed.


### Pack collaboration navigation

Global navigation opens travel lists (`/trips`), the gear library (`/gear`), and collaboration (`/carry`). A trip has Gear, Packing, and Collaboration views. Select gear rows to request help carrying; selecting a kit selects its children, and partial selection shows a mixed checkbox. Requests share only selected gear.

Member names and emails are private to the signed-in account, reusable across devices, included in account export, and deleted with the account. Requests remember recipients automatically; manage saved members in Collaboration. Recipients can register later with that email.

Pending requests keep their weight with the sender. Packing can temporarily hide those tasks on the current device; accepted requests leave the sender’s packing tasks, while declined or cancelled requests reappear. The original weight chart still describes the source list; Collaboration displays confirmed adjusted totals. Recipients can independently group and order accepted items.
