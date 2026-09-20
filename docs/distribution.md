# Distribution / 分发登记材料（计划项 5.1）

**状态**：材料就绪，**尚未投稿** ✓。投稿是公开的外部动作（会在第三方仓库留下以你的账号署名的 PR）✓，
因此这里只准备素材与命令 ✓，实际提交需要你点头 ✓。

**建议顺序**：先把本分支合并到 `master` 再投稿 ✓ —— 现在 `origin/master` 比本分支落后 9 个提交 ✓，
而所有条目链接的都是仓库首页 ✓，先合并能让评审第一眼看到的是当前版本 ✓。

## 一句话与事实（投稿时引用，均来自 README 与实测）

- **英文一句话**：A Cordis plugin suite that pairs Jev (TypeSafe System One decision models) with DeepSeek Harness, adding semantic judgement to tool pruning, dead-loop blocking and high-risk-call guarding.
- **中文一句话**：把 Jev（TypeSafe System One 决策模型）接进 DeepSeek Harness 的 Cordis 插件套件，为工具裁剪、死循环拦截与高危调用把关提供语义判定。
- **可核对的数字**（`bench`/`verify:*` 实测，见 `docs/verification-report.md`）：
  - 装配期：`2139ms -> 12 tools to 5`（工具面从 12 降到 5）；
  - 后置处理：`586ms -> 32680 to 237 chars`；
  - 单次判定成本 ≈ `$0.00013`（2026-09-20，2,254 次判定，每次 12.4 KiB 输入，$0.042/M）；
  - 离线单测 220 项、`bench:offline` 36 条样本准确率 94.4%、`verify:mutants` 82/82 变异被拦。
- **差异点**（评审最关心"与已有条目重复吗"）：本项是**宿主插件**（Cordis/DSH），
  不是库、不是 CLI、不是另一个 agent；领域是**工具面裁剪 + 死循环拦截 + 高危调用把关 + skill 路由**的合体 ✓。

## 四个 awesome 仓（均已确认接受社区 PR）

| 仓库 | 目标位置 | 条目 |
|---|---|---|
| [`yibie/awesome-jev`](https://github.com/yibie/awesome-jev)（399★） | `categories/verification-guardrails.md` 的 `## Entries` | `- [dsh-jev](https://github.com/zhangxaochen/dsh-jev) - Coding agents: hooks Jev into DeepSeek Harness so tool-call safety, loop stalls and tool-surface pruning are typed Jev decisions, with a live metrics panel.` |
| [`AbdelStark/awesome-typesafe`](https://github.com/AbdelStark/awesome-typesafe)（349★） | `## Community projects` → `### Agent and developer tooling` | `- [dsh-jev](https://github.com/zhangxaochen/dsh-jev) — Cordis plugin suite that adds Jev decisions to DeepSeek Harness: dynamic tool pruning, dead-loop blocking, high-risk-call guarding, skill routing.` |
| [`Anil-matcha/awesome-jev-by-typesafe`](https://github.com/Anil-matcha/awesome-jev-by-typesafe)（636★） | `## Related Projects` | 同上英文条目（该节按 `- [name](url) — description.` 排列） |
| [`daftAI2026/awesome-jev`](https://github.com/daftAI2026/awesome-jev)（4★） | `## Tools & integrations` | 同上英文条目 |

> 目标位置与行格式在提交前**再取一次原文对齐** ✓（清单会加条目、改章节标题 ✓，照抄本文件的区块名可能已漂移 ✓）。

## 三个目录站

| 站点 | 需要什么 | 现状 |
|---|---|---|
| [`awesomejev.com`](https://awesomejev.com/) | 搜索式目录，按仓库/演示/基准/文章收录 | 未提交（需站点上的提交入口或表单） |
| [`jev.directory`](https://jev.directory/) | 同类目录 | 未提交 |
| [`madewithjev.com`](https://madewithjev.com/) | "用 Jev 做的产品" | 未提交 |

这三个站点是**网页表单**，无法用 `gh` 自动完成 ✗ —— 需要你（或我按你的指示）在网站上填表 ✓。

## 提交命令（每个 awesome 仓一条，`OWNER/REPO` 与 `FILE` 按上表替换）

```powershell
$repo='yibie/awesome-jev'; $file='categories/verification-guardrails.md'
gh repo fork $repo --clone=false --remote=false          # 幂等，已 fork 会报已存在
git clone --depth 1 (gh repo view (gh api user --jq .login)"/"+($repo -split '/' | Select-Object -Last 1) --json sshUrl --jq .sshUrl) $env:TEMP\awesome-submit
# 编辑目标文件加入条目，然后：
git -C $env:TEMP\awesome-submit checkout -b add-dsh-jev
git -C $env:TEMP\awesome-submit commit -am "Add dsh-jev"
git -C $env:TEMP\awesome-submit push -u origin add-dsh-jev
gh pr create --repo $repo --title "Add dsh-jev" --body "Adds dsh-jev: a Cordis plugin suite that pairs Jev with DeepSeek Harness for tool pruning, dead-loop blocking and high-risk-call guarding. Repo: https://github.com/zhangxaochen/dsh-jev"
```

**PR 正文要点**（每个仓同一套）✓：它是什么（宿主插件，不是库/CLI）✓ / 用 Jev 的哪几个原语
（`Noul` 概率 + `Choice`/`Score`，无采样、可复现）✓ / 可核对的实测数字（上面四条）✓ /
一切证据都在仓库里可复跑（`pnpm test`、`bench:offline`、`docs/verification-report.md`）✓。
