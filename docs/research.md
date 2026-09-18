# 调研记录：借鉴了什么，以及证据在哪

本文件回应两个问题：**这份插件的做法从哪来**、以及**每条借鉴在本仓库里怎么被证明**。

> **诚实的范围声明。** 最初的调研有两个部分：① 外部扫描（用 TypeSafe / Jev 这类 System One 决策原语做成的产品与实践）；② 从这些实践里挑出可借鉴项并落成本次的优化计划。第 ② 部分的产物就是
> [`OPTIMIZATION_PLAN.md`](OPTIMIZATION_PLAN.md)（设计决策 D1–D6）与本文件的表格。第 ① 部分的**原始来源在当时未留档**（该次检索发生在会话中，未把链接与逐条结论写进仓库）；本会话环境亦无联网检索工具，因此**本文件不伪造引用**，只记录可核对的部分，并把外部扫描明确标为未留档。
> 需要补齐外部来源时，应重跑一次检索并把链接补进本文件——而不是从现有文字反推。

## 借鉴项 → 设计决策 → 落地模块 → 本仓库证据

| 借鉴的实践 | 决策 | 落地 | 本仓库中的证据 |
|---|---|---|---|
| 精确重复不必用模型判定，交给宿主已有的确定性检测器 | D2 | `loopGuard.deferExactRepeats`（默认 true）主动让位给 DSH 内置 `dsh-repeat-tool-reminder` | `tests/dsh-contract.spec.ts`：断言该内置包**存在**且其 `thresholds` 默认仍为 `[3,5,8]`；README 分工表 |
| 廉价、确定性的判据应先于模型判据执行 | D3 | `safety-guard` 的 `HARD_DENY_RULES` 注册到 `ctx.tools.guard()`（单调、同步、0 次模型调用） | 集成校验：拒绝时工具体执行 **0** 次，且「一律放行」的后续监听器**从未被调用** |
| 失败模式要**分级**，而不是统一 fail-open | D4 | 安全/审批路径 fail-closed（`onError`/`onUncertain` 默认 `deny-guarded`），建议路径 fail-open | `tests/resilience.spec.ts`：429/500/超时 → `deny`；`onError: 'allow'` 保留旧行为 |
| 指标只报**可测**的量，不折算想象出来的收益 | D5 | `metrics` v2：精确移除字符数 + `ctx.tokenMeter` 定价，`tokenSource` 标明口径；删除 `TOKENS_PER_PRUNED_TOOL` 等魔数 | `tests/metrics.spec.ts`；README 声明「不做不可测的 token 折算」 |
| 压缩应与宿主内置能力**互补而非重复** | D6 | `result-shaper` 只补「中段语义选段」，head/tail 交给 `dsh-spill-policy` / `dsh-compaction-tool-result-pruner` | README 分工表；`tests/dsh-contract.spec.ts` 断言两者均已安装；`docs/calibration.md` §9 |
| 打分前先**确认刻度**，别假设它是索引 | D1 | 探针确认 `score` 是 `[0, n-1]` 的期望值、`noul` 只有 `noul` 字段载概率 | `docs/calibration.md` §1；`docs/calibration/probe-*.json` |
| 用**校准后的置信度**快速通道高确定项、把模糊项升级出去 | —（贯穿） | `minConfidence` 门槛 + `unknown` 一律不动手；死循环判定要求桶概率与置信度同时达标 | `tests/loop-guard.spec.ts` 的低置信度用例；`verify:live` 三场景 |

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
| 把外部调研结论当作依据写进文档 | 原始来源未留档；写进去就成了不可核对的主张 |

## 复现本文件提到的证据

```bash
pnpm test                 # 单测（含 dsh-contract 的宿主论断）
pnpm run verify:dsh       # 真实 runtime 集成（含确定性外壳优先级）
pnpm run verify:live      # 历史误报形态回放（走发布规则）
pnpm run drill            # 对每条承诺注入回归，确认闸门拦得住
```

设计决策的完整列表见 [`OPTIMIZATION_PLAN.md`](OPTIMIZATION_PLAN.md) 的「设计决策」一节；逐条实测数字见 [`calibration.md`](calibration.md)。
