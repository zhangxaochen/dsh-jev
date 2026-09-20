# 发版

发布是**推 tag 一个动作**：`.github/workflows/release.yml` 监听 `v*` 标签，先断言「tag == `package.json` 版本 == CHANGELOG 有该版本小节」（三者不一致直接失败），再把完整 CI 闸门重跑一遍（复用 `ci.yml`），然后 `npm publish --provenance` 并用 CHANGELOG 该小节建 GitHub Release、附上 tarball。分支推送永远不会触发发布。

```bash
# 1. 改 package.json 的 version，并在 CHANGELOG 写下 ## [x.y.z] 小节
# 2. 提交后打 tag 推送
git tag v0.2.0 && git push origin v0.2.0
```

## 一次性配置

只能在 npmjs.com 上做，仓库侧做不了：

- 包设置页是 `https://www.npmjs.com/package/dsh-jev/access`（**不是** `/settings`，那个路由是 Route not found）。
- 其中 **Trusted Publisher** 配为 GitHub Actions + `zhangxaochen/dsh-jev` + 工作流文件名 `release.yml`，environment 留空。
- **必须勾选 `Allow npm publish`**：2026-09-03 之后新建的配置默认只允许 `npm stage publish`，漏勾会让工作流里的 `npm publish` 被拒。
- 该页面要求 2FA（安全密钥或密码），且保存时会再要一次（sudo mode）。

配好之后 CI 用 OIDC 取短期凭证发布，不需要 `NPM_TOKEN`，也不需要轮换长期 token。

## 约束

- tag、`package.json`、CHANGELOG 三处版本号必须一致 —— `tests/release.spec.ts` 守着当前版本必须有 CHANGELOG 小节、工作流必须 tag-only 且带 `id-token`/`contents` 权限、必须先过 CI 再发布。
- npm 不允许同一版本重复发布：发错了只能改版本号再发（`0.2.1`），因此发布前先跑 `pnpm run verify:pack`。
