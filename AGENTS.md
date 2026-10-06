# Pack 工作指引

这是独立的装备应用仓库，基于 Mahonia。先读 README.md、DEPLOYMENT.md 和 CLAUDE.md 中的代码及检查约定。

- 正式地址：https://pack.yuweiliang.com；Vercel project 为 yuweiliang-com-pack。
- 修改代码后按影响范围检查；不要覆盖用户已有未提交修改。
- 本地 PGlite 与线上 Neon 数据库互相独立；不要重复迁移或以本地数据覆盖线上。
- 本地 .data、.trial*、.household*、Notion 源数据及密钥不可提交或部署。
- Git origin 是 yuwei-liang/pack，upstream 是 ryankiley/mahonia。个人定制保存在 origin；通用修复用独立分支向 upstream 提 PR。发布目前使用 Vercel CLI。
- 保留上游来源、Git 历史及 MIT 许可证。
- 此项目不处理 life 里的家庭财务资料。
