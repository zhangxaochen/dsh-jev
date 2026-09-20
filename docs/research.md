# 调研记录：借鉴了什么，以及证据在哪

本文件回应两个问题：**这份插件的做法从哪来**、以及**每条借鉴在本仓库里怎么被证明**。

> **诚实的范围声明。** 调研有两个部分：① 外部扫描（用 TypeSafe / Jev 这类 System One 决策原语做成的产品与实践）；② 从这些实践里挑出可借鉴项并落成优化计划。第 ② 部分的产物是
> [`OPTIMIZATION_PLAN.md`](OPTIMIZATION_PLAN.md)（设计决策 D1–D6）与本文件的表格。第 ① 部分在最初一轮**未留档**，现已在 `docs/PLAN-0.3.md` 的 1.1 补齐：扫描快照连同日期入库为
> [`community-scan-2026-09-19.md`](community-scan-2026-09-19.md)，本文件只引用其中的**形态与结论**，并保留原始链接以便复核。
> 快照里的数字（星数、计数、讨论量）**只增不减**，引用时必须带日期；本文件不把当时的数字当现值。
> ③「知道了但决定不做」的项同样记录在下表，并写明**重开条件**——否则「未采纳」与「没想到」在文档里长得一模一样。

## 借鉴项 → 设计决策 → 落地模块 → 本仓库证据

| 借鉴的实践 | 决策 | 落地 | 本仓库中的证据 |
|---|---|---|---|
| 精确重复不必用模型判定，交给宿主已有的确定性检测器 | D2 | `loopGuard.deferExactRepeats`（默认 true）主动让位给 DSH 内置 `dsh-repeat-tool-reminder` | `tests/dsh-contract.spec.ts`：断言该内置包**存在**且其 `thresholds` 默认仍为 `[3,5,8]`；README 分工表 |
| 廉价、确定性的判据应先于模型判据执行 | D3 | `safety-guard` 的 `HARD_DENY_RULES` 注册到 `ctx.tools.guard()`（单调、同步、0 次模型调用） | 集成校验：拒绝时工具体执行 **0** 次，且「一律放行」的后续监听器**从未被调用** |
| 失败模式要**分级**，而不是统一 fail-open | D4 | 安全/审批路径 conservative：`onUncertain` 默认 `deny-guarded`；「判定拿不到」按运行期依赖处理（`onError` 默认 `allow`，失败计数并告警）；无法弹窗时的 `ask` 默认 `warn` 放行 | `tests/resilience.spec.ts`；`tests/safety-guard.spec.ts`；`docs/calibration.md` §23 |
| 指标只报**可测**的量，不折算想象出来的收益 | D5 | `metrics` v2：精确移除字符数 + `ctx.tokenMeter` 定价，`tokenSource` 标明口径；删除 `TOKENS_PER_PRUNED_TOOL` 等魔数 | `tests/metrics.spec.ts`；README 声明「不做不可测的 token 折算」 |
| 压缩应与宿主内置能力**互补而非重复** | D6 | `result-shaper` 只补「中段语义选段」，head/tail 交给 `dsh-spill-policy` / `dsh-compaction-tool-result-pruner` | README 分工表；`tests/dsh-contract.spec.ts` 断言两者均已安装；`docs/calibration.md` §9 |
| 打分前先**确认刻度**，别假设它是索引 | D1 | 探针确认 `score` 是 `[0, n-1]` 的期望值、`noul` 只有 `noul` 字段载概率 | `docs/calibration.md` §1；`docs/calibration/probe-*.json` |
| 用**校准后的置信度**快速通道高确定项、把模糊项升级出去 | —（贯穿） | `minConfidence` 门槛 + `unknown` 一律不动手；死循环判定要求桶概率与置信度同时达标 | `tests/loop-guard.spec.ts` 的低置信度用例；`verify:live` 三场景 |
| 一次请求把多个原子问题**打包**（官方文档称 speculative fan-out；高星形态把它用在"同时选操作与选元素"） | —（贯穿） | `typesafe-client` 的批量提问：`safetyGuard.rules` 与内置问题同一次请求、组装期的剪枝与路由各自一次请求 | `tests/live-tools.ts`（3 问一次请求）；`tests/live-turn.ts` 断言组装期调用数 ≤2 |
| 用**自然语言条件**当谓词，不需要索引与 embedding | D3 | `safetyGuard.rules: [{ id, question, threshold, action }]` 与内置问题同批评估 | `tests/safety-guard.spec.ts` 的自定义规则用例 |
| 判定结果决定**是否还要花钱调大模型**：只在必要时才升级 | D3 | 确定性外壳命中即拒（0 次模型调用）；`loop-guard` 仅在连续无进展达阈值后才发起判定；剪枝/路由在意图过短或目录过小时**不发请求** | `tests/loop-guard.spec.ts`、`tests/tool-pruner.spec.ts`、`tests/skill-router.spec.ts` 的跳过用例 |

## 本仓库自己测出来的（非借鉴，勿混记）

这些是实测结论，来源是本仓库的标定与审计，不来自外部调研：

- **逐项提问必须把项内容写进问题本身**（`docs/calibration.md` §9.3）：把项放进 `state` 再按索引指代，会让模型对每条问题给出同一答案。由 `tests/question-binding.spec.ts` 守卫。
- **闸门若复刻被它守护的规则，就会在规则变更时保持绿灯**（§13）：bench 与 `verify:live` 都曾复刻阈值；现均调用发布代码，并由 `pnpm run drill` 注入回归验证。
- **发布默认值若被所有测试显式覆盖，就等于从未被测量**（§12）：`minScoreThreshold: 2` 因此长期无覆盖，实测多步意图下只留一个专用工具，故补 `minKeep` 下限。
- **行覆盖率高不等于行为被验证**（§14）：两个覆盖率不低的模块各藏一条从未执行的用户可见路径（`connection.fetch` 路由、客户端真实 `fetch` 与缓存）。

## 主动**未**采纳的实践

| 实践 | 为什么不做 |
|---|---|
| `result-shaper` 默认开启 | 它改变模型所见（只留 warning/failure 类行），必须由部署方显式启用；实测在构建日志上模型无法区分报错块与噪声块（§9） |
| 用「哪一部分重要」这类**理解型**问法驱动压缩 | 五种问法实测均不可靠（平坦分布或自信选错），改用行形状聚类 + 有界分类（§9.4） |
| 词法预筛候选目录（`skillRouter.maxCandidates`）默认开启 | 对「请求语言与技能描述语言不同」的场景有丢正确项的风险（§11.4），故默认 0（不裁剪） |
| 用累计 token 折算展示「收益」 | 无法测量，只会制造好看但虚假的数字（D5） |
| 直接引用扫描快照里的数字当现值 | 星数与计数只增不减（同一件事 6,258 > 5,036、1,899 > 1,863）；本文件只引用形态与结论，引用数字必须带日期 |
| **模型路由**：每轮按任务难度挑最便宜的模型 | 模型选择在宿主里是 UI 投影 + 用户选择（`installModelSelection`），子代理侧是 `subagent/model-selection-policy` 的 `allowedModels`；插件去抢会与用户选择打架。另：扫描里"路由"这条热度指的是**模型**路由，本插件做的是 **skill** 路由，两者不能算同一覆盖。重开条件：宿主暴露"每轮可建议模型"的钩子 |
| **本地/内网小模型端点** | 前提是用户手里有一台推理机——研究者的 proof-of-concept（4B/0.6B 单次前向、prefill-only 兼容端点）不等于用户的部署形态；真正需要它的内网场景只有上游出私有部署才有解。`client.baseUrl` 保持可改，但不为此写代码。重开条件：上游提供私有/VPC 部署 |
| **computer-use**（OCR 读屏 + 选下一步） | 宿主没有这个执行层，分工原则下不该做；可借的只有"每步成本"口径。重开条件：宿主引入 computer-use 执行层 |
| **会话级 compaction 替换摘要** | 压缩协议与不变量归宿主（`dsh-compaction-tool-result-pruner`）；§6.1 为组合方式的实测结论。重开条件：宿主开放稳定接管点 |
| **新写产物/代码审查模块** | 属宿主 `code-review` skill 的领域，重复建设；改为提升路由命中率。重开条件：宿主放弃该 skill |
| **`completion-guard`**（turn 结束时判断"宣称的完成是否有证据"并注入纠偏） | 发生率**测不出来**：本机可用的逐轮语料只有会话投影（`session_projcache` 的 `turnOutline`），其中 94% 的回复被截断，32 条完成断言里**只有 11 条**后面还有用户 turn，严格纠正 **1** 条（另 1 条宽松命中经人工复核为假阳性）；而最需要护栏的自主 goal 轮**恰好没有人类纠正信号**，拿它标定等于用假数据标定。该护栏误报会让本该结束的 turn 不结束，代价不对称。重开条件：用 `dsh-session-log-export` 导出消息级语料后重跑 `pnpm run probe:completion`，可观测样本达数百条且严格纠正占比可观（§30） |

## 复现本文件提到的证据

```bash
pnpm test                 # 单测（含 dsh-contract 的宿主论断）
pnpm run verify:dsh       # 真实 runtime 集成（含确定性外壳优先级）
pnpm run verify:live      # 历史误报形态回放（走发布规则）
pnpm run drill            # 对每条承诺注入回归，确认闸门拦得住
```

设计决策的完整列表见 [`OPTIMIZATION_PLAN.md`](OPTIMIZATION_PLAN.md) 的「设计决策」一节；逐条实测数字见 [`calibration.md`](calibration.md)。
