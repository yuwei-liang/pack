# Pack production

上线日期：2026-10-06。

- 地址：https://pack.yuweiliang.com
- Vercel project：`yuweiliang-com-pack`，team `yuwei-liangs-projects`。
- Cloudflare：`pack` DNS-only CNAME → `cname.vercel-dns.com`。
- Neon project：`tiny-queen-99444778`；独立 branch `pack-production` (`br-floral-silence-aqbvgq9b`)，database `pack`，role `pack_owner`。新数据库只存装备应用数据。
- Resend：独立 sending-only key `Pack production sending`，限定 `yuweiliang.com`；发件人 `Pack <pack@yuweiliang.com>`。
- Production env：`DATABASE_URL`、`RESEND_API_KEY`、`MAHONIA_ORIGIN`、`AUTH_EMAIL_FROM`，密钥保存在 Vercel 环境变量中，不写入本文件。

## 使用

Yuwei 使用 `fredlyw@gmail.com` 邮件链接登录；已迁移 121 件装备、24 个装备库文件夹、Big Pine 清单 50 件物品及 5 个历史快照，并将清单关联到该账户。

Molly 使用自己的邮箱登录，获得独立账户、装备库和清单。需要共同编辑时分享清单的编辑链接。Mahonia 的清单采用链接权限：持有编辑链接的人仍可编辑，不等同于账户私有清单。

以后使用云端地址。本地 trial 与云端使用不同数据库，后续修改不会自动互相同步。此次迁移没有包含本地密码、邀请文件、会话或测试清单。

## 发布

代码目录：`/Users/yuweiliang/workspaces/pack`。此目录是独立 Git 仓库，不属于 life 或 yuweiliang-com。

在本目录执行：

```sh
cd /Users/yuweiliang/workspaces/pack
vercel deploy --prod --yes --scope yuwei-liangs-projects
```

代码备份在 https://github.com/yuwei-liang/pack ，`origin` 指向个人 fork，`upstream` 指向 Mahonia。通用修复使用独立分支提上游 PR。

目前通过 CLI 发布；未建立 GitHub 自动部署。`.vercelignore` 排除了本地快捷入口、家庭密码登录实验、Notion 源数据和迁移工具。不要把本地凭证加入部署包或 Git。

## 验证

- 自定义域名 HTTPS 正常。
- 云端编辑 API 的 50 件物品和文件夹与本地迁移快照一致。
- 真实生产登录邮件已收到，浏览器账户确认 `fredlyw@gmail.com` / Yuwei。
- 已登录装备库显示 121 件装备；无需编辑 token 可打开 Big Pine 清单，刷新后仍能访问。
- 生产 `/trial`、`/household`、本地身份接口和临时迁移接口返回 404。
- 临时本地导出及凭证传输路由已删除。

邮件中的链接只能使用一次；其他设备需要重新申请链接。
