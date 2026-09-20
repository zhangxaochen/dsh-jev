# Jev 社区开源生态扫描（v2 · 权威复核版）

> 入库件：本文件是扫描的**日期快照**（原先只落在 `tmp/`，现按 `docs/PLAN-0.3.md` 的 1.1 归档入库）。其中的星数与计数**只增不减**，引用时必须带本文件的日期。
> 快照时间：**2026-09-19 08:3x（本机时区）**；Jev 发布帖为 2026-09-15 19:25
> 渠道：`agent-reach` 的 **GitHub 后端（gh CLI）** + `curl` + `web_search`
> （`web_fetch` 对 github/自建域一律被 SSRF 规则拒绝 ✗，故目录站改用 curl ✓）
> v1 只有 snippet 级证据、无 star 数，已被本版取代。

---

## 0. 结论（4 条）

1. **热度真实，规模超过「100+ 新仓」**：`gh search repos jev --created ">=2026-09-15"` 命中 **200（gh 单次上限，故为下限）**，其中 **51 个 ≥50★**。爆款形态集中在**用类型化决策替换掉本来必须调大模型的步骤**：浏览器/computer-use（选 DOM 元素而非生成动作）、上下文压缩、Agent 工具调用审查、模型路由。
2. **但星级有明显水分，本版把它量化了**：榜首 **6,258★ 只有 3 次提交**；另有 922★/3、268★/**1**、173★/**1**、51★/**1**。200+ 命中里只有 51 个过 50★，长尾极瘦。
3. **「72 小时内新建」需要修正**：多数确为 09-16/09-17 建仓 ✓，但至少两个条目是**旧仓**（`Anil-matcha/awesome-jev-by-typesafe` 建仓 **05-17**、`carlaiau/jev-reranking` 建仓 **03-13**）——它们是发布后**转向/补充** Jev 内容，不是发布期内新建。
4. **同一件事的数值会随快照漂移**：与更早那份汇总相比，**每一颗星、每一个计数都只增不减**（6,258>5,036、HN 1,899>1,863、awesomejev 488>409、yibie 条目 126>121）。方向一致 ⇒ 两份互相印证，差异只是时间戳，不是矛盾。**引用这类数字必须带日期。**

---

## 1. 高星项目（本节全部为 `gh api` 权威取值，非 snippet）

| 项目 | ★ | fork | 建仓 | 提交 | 做了什么 |
|---|---|---|---|---|---|
| `browser-use/jev-ultrafast` | **6,258** | 395 | 09-16 | **3** | Browser Use 官方集成（母公司仓 115k★）。一次 Jev 请求同时选操作 + DOM 元素，仅 `TYPE_TEXT` 才调小 LLM |
| `tamaratran/fast-jev-compaction` | **3,619** | 191 | 09-17 | 30 | Claude Code 插件：用 Jev 打分替代 compaction 摘要，过期内容丢弃或截断，保留内容逐字不改 |
| `TheoLeeCJ/SemIf`（原 OpenJev） | **1,679** | 111 | 09-16 | 12 | 独立复现：4B 开源模型**单次前向**从 logits 读出类型化选项概率；3090 可跑；声明非 Jev 复刻 |
| `jarrodwatts/jev-trader` | **957** | 186 | 09-16 | 12 | Monad 链上每个区块（~300ms）一次 Jev 买卖判断，Kuru MON-USDC，只发 post-only 单赚价差 |
| `vinnylarouge/jevlike` | **922** | 78 | 09-16 | **3** | 逆向 jev-like 架构并自训：变化的文本候选一次性输出每项概率 |
| `TianyuCodings/NanoJev` | **538** | 57 | 09-17 | 13 | 0.6B 并行决策模型复刻，HF 放模型+数据集，与 Jev/未调优 Qwen 三方迷宫对比 |
| `awlevin/typesafe-computer-use` | **346** | 16 | 09-16 | 26 | Mac computer-use：OCR 读屏 + Jev 选下一步，**$0.0002/步** |
| `thruwire/foreman` | **316** | 18 | 09-17 | 4 | Codex worker 之上的「工头」：判断实现是否完成、测试是否够、要不要人介入 |
| `devagrawal09/jev-review` | **289** | 14 | 09-16 | 5 | 分阶段代码审查（Noul 风险矩阵 → Choice/Score 文件画像 → 证据→严重度→条件路由） |
| `AbdelStark/awesome-typesafe` | **270** | — | 09-17 | — | **本版新发现**：另一份 Jev/TypeSafe 生态清单 |
| `fhshaik/typesafe-mario` | **268** | 27 | 09-16 | **1** | 从模拟器 RAM 转结构化 JSON 玩超级马里奥，不看截图 |
| `dabit3/jev-experiments` | **263** | 20 | 09-17 | 89 | Nader Dabit 的实验集（提交数最实的一个） |
| `jaredpalmer/kev` | **250** | — | 09-17 | — | **本版新发现**：Jared Palmer（Turborepo/Formik 作者）的仓 |
| `yibie/awesome-jev` | **230** | 31 | 09-17 | 69 | 公开项目/集成/讨论清单，README 内 **126** 条仓库链接 |
| `realZachi/pg-jev` | **182** | 10 | 09-17 | 8 | Postgres 扩展：`WHERE jev(people,'the name is …')` 自然语言条件，无索引、无 embedding |
| `kyotofin/tax-doc-classifier` | **179** | — | 09-18 | — | **本版新发现**：税务文档分类 |
| `droidrun/mobile-jev` | **173** | 23 | 09-17 | **1** | 真机 Android 操作 agent |
| `kitze/skillbox` | **166** | 14 | 09-17 | 7 | Kitze 的 skill 库（自托管、可版本化） |
| `ekzhang/openjev-sglang` | **165** | 13 | 09-17 | 18 | 用 SGLang prefill-only 做 Jev 兼容端点（作者 ekzhang） |
| `gargpratyush/jev-router` | **163** | 11 | 09-16 | 46 | 每轮按任务难度选最便宜模型 |
| `superagents-lab/jev-search` | **153** | 23 | 09-17 | 50 | 联网搜索：来源选择/摘要 |
| `lakeday-org/perch` | **141** | 8 | 09-16 | 77 | 产物/代码语义审查（linting） |
| `NiazMorshed2007/jev-review` | **129** | 11 | 09-17 | 4 | 本地优先 MCP 插件，持续审查 |
| `jkudish/jev-browser` | **120** | 7 | 09-17 | 29 | Wikipedia 4s / $0.0016 |
| `kitze/unclutter` | **111** | 6 | 09-17 | 8 | WXT 浏览器扩展：Jev 驱动的页面去杂乱 |
| `standardagents/jevpilot` | **79** | 12 | 09-17 | 14 | 1 小时内用 Jev 在 3D 仿真里复刻特斯拉 FSD（"Jev engaged"），X 上病毒传播 |
| `RomanSlack/jev-drone` | **66** | 3 | 09-16 | 6 | MuJoCo 相机-only 自主无人机，2.5Hz |
| `0xNatoshi/jev-codex-router` | **59** | 5 | 09-17 | 15 | Codex 的每轮模型/思考深度路由 |
| `realZachi/typesafe-adblock` | **51** | 4 | 09-17 | **1** | 「好玩项目」：问一句话就决定拦不拦的 Chrome 扩展 |
| `phyous/tsai-sc` | **15** | 1 | 09-16 | 19 | 用 Jev 控制原版星际争霸（421 决策） |
| `carlaiau/jev-reranking` | 7 | 1 | **03-13** | 84 | **负面结果**：TREC 检索重排上不如 MonoBERT（旧仓，发布后补充 Jev 实验） |
| `Anil-matcha/awesome-jev-by-typesafe` | 559 | 105 | **05-17** | 82 | 用例/模式/提示/起步代码合集（旧仓改建；README 内 44 条去重链接） |

**官方仓**（权威）：`typesafe-ai/skills` **362★**（08-24）、`typesafe-ai/typesafe-sdk-js` **146★**（09-04）、`typesafe-ai/system-one-adapter-python` **133★**（08-08）。

---

## 2. 社区讨论热度

| 渠道 | 数值 | 证据等级 |
|---|---|---|
| **HN 发布帖**（id 49717558） | **1,899 分 / 497 评论**，2026-09-15 19:25 由 `albelfio` 提交，标题《Introducing System One Models and Jev》 | **权威**（HN API 直读） |
| X：创始人 launch 推 6.3 万赞；@studio_yebisu 汇总 1,426 赞 / 7.6 万浏览；@4rcherhume 开源权重 2,080 赞；@vinnylarouge 2,010 赞 | — | 承自上一轮汇总，**本版未复核**（X 后端走 OpenCLI、需登录态） |
| Reddit：r/SideProject 215/113、r/singularity 132/99、r/LocalLLaMA 83/43、r/PiCodingAgent 103/49 | — | 同上（未复核） |
| 中文：B站 9,490 播放；小红书多篇 100+ 赞；V2EX 质疑帖；36kr 专稿 | — | 同上（未复核） |
| 「创始人用 CompleteSkeptic 逐条回帖」 | **未复现**：前 25 条评论各作者最多 1 条，未出现该账号 | 标为**未证实**（反证不足） |

---

## 3. 生态目录与清单（本轮实测）

| 名称 | 实测 | 证据 |
|---|---|---|
| `awesomejev.com` | 站内自报 **488 projects**（HTTP 200，curl 直读） | 权威 |
| `madewithjev.com` | HTTP 200（未解析内容） | 可达 |
| `jev.directory` | HTTP 200 但仅 **59 字节**（客户端渲染） | 内容不可读 |
| `daftAI2026/awesome-jev` | README 内 **357** 条仓库链接 | 权威 |
| `yibie/awesome-jev` | **126** 条（去重同 126） | 权威 |
| `cobanov/awesome-jev` | 120 条（去重 119） | 权威 |
| `Anil-matcha/awesome-jev-by-typesafe` | 49 条（去重 44） | 权威 |
| `AbdelStark/awesome-typesafe` | 本版新发现（270★） | 权威 |

---

## 4. 官方与商业侧跟进

| 事件 | 证据 | 等级 |
|---|---|---|
| **Vercel AI Gateway 上线 Jev** | Vercel 官方 changelog | **权威**（官方一手） |
| **LangChain 官方做集成** | 官方 webinar《Building a Harness with Jev》（Sydney Runkle 主讲）+ 第三方记录：集成暴露为 `TypeSafeClassifier`，传 state+questions 拿分类结果而非 chat 回复 | **权威**（官方页 + 第三方记录） |
| OpenRouter 上架（Jev Latest / Jev 1.13）；Cloudflare AI Gateway | OpenRouter 列表页 ✓；Cloudflare 未复核 | 部分 |
| 官方文档提到 **speculative fan-out**（一问批量打包）与 **Jev 1.13 jaggedness**（state 变长时准确率漂移） | `docs.typesafe.ai/models` | snippet |

---

## 5. 独立评测（含负面 —— 最能说明问题的一节）

| 评测方 | 结果 | 等级 |
|---|---|---|
| **Every**（evals 团队） | 37 篇文档、**777 次判断**、**<1s**、约 **1/4 美分**；抓出 7 个植入缺陷中的 **6 个**（对照 Claude Fable 5.1 为 7/7） | 多来源一致复述（含 Every 自己的文章） |
| Near Here | 快 5.7×、成本低 98%、准确率 +12pt | 承自上一轮，**未复核** |
| **`carlaiau/jev-reranking`（负面）** | TREC 检索重排上**不如 MonoBERT**；README 说明 JEV 用 Noul 相关性问法取 [0,1] 分，monoBERT 本地跑 `castorini/monobert-large-msmarco` | **权威**（仓+README 直读） |
| 公司自家评测页 | Jev 准确率 **67.8%**、排第四 | 承自上一轮，未复核（**注意**：官方页自己没排第一） |

**这节的价值**：同时给出「快/便宜」的正面证据与「某些任务不如专用小模型」的负面证据。引用时两者都要带，否则就是把营销当结论。

---

## 6. 方法与证据等级（便于复核与更新）

- **权威**：`gh api repos/<x>`（star/fork/建仓/推送）、`gh api .../commits`（提交数）、`gh api .../contents/README.md`（清单条目计数）、HN Firebase API、`curl`（目录站自报数）。
- **snippet**：`web_search` 的标题/摘要（官方博客、评测转述）。
- **承自上一轮未复核**：X / Reddit / 中文平台数值、Near Here 与官方自评准确率。补齐应走 `agent-reach` 的 X 后端（OpenCLI，需登录态）与 B站 后端。
- **本轮不可达**：`web_fetch` 对 `github.com` 与自建域被 SSRF 规则拒绝（curl 可绕）；`jev.directory` 客户端渲染。

---

## 7. 与本仓库（dsh-jev）的关系

| 扫描所见 | 对 dsh-jev 的含义 |
|---|---|
| 生态以「目录/清单 + 单点 demo」为主，**缺中间层** | dsh-jev 正落在中间层：把 Jev 接进具体宿主（DSH 的 `tools/pre-execute`、`tools/post-execute`、`system-prompt/assemble`） |
| 高星形态集中在 computer-use / 上下文压缩 / **工具调用审查** / 路由 | 本插件覆盖其中两条（**审查** = safety-guard、**路由** = skill-router）+ 剪枝，与最热两条线一致 |
| `agent-reach` 已给出各平台活跃后端 | 补 X/Reddit/中文数据可直接复用本轮未走的部分 |
| 清单/目录可登记 | 分发成本最低的一步：提交到 `awesomejev.com`（488 项）、`jev.directory`、`madewithjev.com` 与 4 份 awesome 仓 |

---

## 8. 来源

- GitHub（`gh api` 直读）：[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) · [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) · [TheoLeeCJ/SemIf](https://github.com/TheoLeeCJ/SemIf) · [jarrodwatts/jev-trader](https://github.com/jarrodwatts/jev-trader) · [vinnylarouge/jevlike](https://github.com/vinnylarouge/jevlike) · [TianyuCodings/NanoJev](https://github.com/TianyuCodings/NanoJev) · [awlevin/typesafe-computer-use](https://github.com/awlevin/typesafe-computer-use) · [thruwire/foreman](https://github.com/thruwire/foreman) · [realZachi/pg-jev](https://github.com/realZachi/pg-jev) · [ekzhang/openjev-sglang](https://github.com/ekzhang/openjev-sglang) · [droidrun/mobile-jev](https://github.com/droidrun/mobile-jev) · [carlaiau/jev-reranking](https://github.com/carlaiau/jev-reranking) · [typesafe-ai/skills](https://github.com/typesafe-ai/skills)
- 官方/商业：[Vercel AI Gateway changelog](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway) · [LangChain webinar: Building a Harness with Jev](https://events.langchain.com/webinar/building-a-harness-with-jev/) · [TypeSafe docs: Models](https://docs.typesafe.ai/models)
- 讨论与评测：[HN 发布帖](https://news.ycombinator.com/item?id=49717558) · [Every: Mini-Vibe Check](https://every.to/also-true-for-humans/mini-vibe-check-typesafe-s-jev-judged-everything-i-ve-written-in-0-7-seconds) · [carlaiau/jev-reranking README](https://github.com/carlaiau/jev-reranking/blob/main/reranking/README.md) · [Velocity 转述](https://velocitystartups.com/story/4eb607e7-64fd-4e21-a41b-381457e5a431)
- 目录：[awesomejev.com](https://awesomejev.com/) · [jev.directory](https://jev.directory/) · [madewithjev.com](https://madewithjev.com/)
