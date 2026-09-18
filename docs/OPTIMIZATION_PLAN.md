# dsh-jev 优化计划（可勾选执行清单）

> 依据：本会话实测基线 + 调研结论（借鉴项与证据见 [`research.md`](research.md)；该文件同时说明外部扫描部分未留档的原因）。
> 执行规则：每完成一个 Phase，勾选本文件，代码 + 本文件一起提交一次，再进入下一个 Phase。

## 交付摘要（先读这里）

从 `0.1.0`（阈值靠猜、出错即放行）到 `0.2.0`（阈值有实测依据、失败模式明确）。全部改动按 Phase 提交，
每份提交都含代码与本文件；缺陷清单与证据索引见 [`verification-report.md`](verification-report.md)，
实测数字与阈值来源见 [`calibration.md`](calibration.md)。

| 模块 | 现在做什么 | 默认 | 验证手段 | 关键实测 |
|---|---|---|---|---|
| `typesafe-client` | 封装 Jev（批量提问、相同载荷缓存、输入字节与费用记账） | 开 | 单测 12 项 | 热调用 250–300ms；默认超时 2000ms、建议路径 800ms |
| `loop-guard` | 语义死循环判定；精确重复让位 DSH 内置提醒 | 开 | 单测 13 项 + `verify:live` + 36 条基准 | 误报 0；真循环 `pLoop≈0.86` 命中 |
| `safety-guard` | 确定性硬拒集 + 语义裁决 + 用户自定义规则；受保护工具 fail-closed | 开 | 单测 11 项 + 92 例命令语料 + 36 条基准 + 服务级集成 | 危险集 100% 拦下、工具体执行 0 次 |
| `tool-pruner` | 按意图打分只注入 Top-K 工具，保持上游顺序 | 开 | 单测 8 项 + `verify:pruner` + 服务级集成 | 6/6 标注用例，必需工具零遗漏 |
| `ask-tools` | `jev_ask` / `jev_rank` / `jev_check` 决策原语 | 开 | 单测 7 项 + `verify:tools` | 3 问一次请求 811ms；否定断言 p=0.04 |
| `skill-router` | 为当前请求指出一个最该载入的 skill（advisory） | 开 | 单测 9 项 + `verify:router` + 服务级集成 | 112 项目录 1.4s；6/7 标注意图命中 |
| `result-shaper` | 行形状聚类后做有界分类，只留 warning/failure | **关** | 单测 12 项 + 16 例前置检查语料 + `verify:shaper` + 服务级集成 | 压缩 130×–190×；纯噪声拒绝 |

合计 **161** 个离线单测、**22** 项真实 DSH 集成检查、5 个线上验证脚本、30 条 A/B 基准。

## 基线（本会话实测，`~/.dsh/jev-stats.json`）

| 指标 | 实测值 | 问题 |
|---|---|---|
| System One 调用 | 776 次 / 平均 650ms / 错误 21（2.7%） | 关键路径累计约 8.4 分钟 |
| loopGuard | 327 次检查 → 16 次干预 | 其中 ≥2 次已确认误报（`read`/`pwsh`，severity 1.4 与 1.63，confidence 28%/44%） |
| toolPruner | 241 次评估 / 裁掉 6061 个工具 | token 收益为 `pruned × 150` 估算，未与 tokenMeter 对账 |
| safetyGuard | 178 次审查 / 5 阻断 / 4 审批 | 出错即放行；headless 下 `ask` → 放行 |

## 设计决策

- **D1** 阈值不用魔数，改为「桶概率 + confidence」；`score` 刻度先由探针确认。
- **D2** 精确重复交给 DSH 内置 `dsh-repeat-tool-reminder`（阈值 3/5/8）；dsh-jev 只做近似/语义停滞，可选升级为阻断。
- **D3** 确定性外壳优先：廉价信号命中才升级给 Jev。
- **D4** 失败模式分级：安全/审批路径 fail-closed，建议/压缩路径 fail-open。
- **D5** 指标只认真测（`ctx.tokenMeter`）与真钱（输入 $0.042/M，输出免费）。
- **D6** 压缩与 DSH 内置 `spill-policy` / `compaction-tool-result-pruner` 互补，只补「语义选段」。

---

## Phase 0 — 探针与基线

- [x] `tests/probe.ts`：打印 noul/choice/score 真实返回结构（score 刻度、probabilities、confidence）与延迟
- [x] `docs/calibration.md`：记录探针结论 + 基线表 + 阈值来源
- [x] 运行探针并将输出写入 `docs/calibration/probe-<date>.json`

## Phase 1 — 正确性与失败模式

- [x] `src/loop-guard.ts`：删除反向三元阈值（原 `:143`），改用桶概率 + `minConfidence`（默认 0.5）
- [x] `src/loop-guard.ts`：`Map<string, StepRecord[]>` → `WeakMap<agent, Chain>`，加 `maxHistory`（默认 8）
- [x] `src/loop-guard.ts`：agent key 用对象，不用 `id ?? 'default'`
- [x] `src/loop-guard.ts`：监听 `agent/pre-step`，新用户消息清链
- [x] `src/loop-guard.ts`：触发条件改为「连续无进展步数」
- [x] `src/loop-guard.ts`：新增 `cooldownSteps`（默认 3）
- [x] `src/loop-guard.ts`：新增 `deferExactRepeats`（默认 true），精确重复让位内置 remonder
- [x] `src/loop-guard.ts`：progress 缺失不再默认 1，unknown 即不动作
- [x] `src/safety-guard.ts`：新增 `onError` / `onUncertain`（guarded 默认 deny）
- [x] `src/safety-guard.ts`：headless 下 `ask` → `deny`（guardedTools）
- [x] `src/safety-guard.ts`：缺失/NaN 概率走 unknown 分支，不再当 0
- [x] `src/safety-guard.ts`：确定性硬拒集注册到 `ctx.tools.guard()`
- [x] `src/safety-guard.ts`：`rules: [{ id, question, threshold, action }]` 自定义规则
- [x] `src/safety-guard.ts`：凭据类别 Noul（4 组），避免 `read .env` 一律高危
- [x] `src/typesafe-client.ts`：`normalizeAnswers` 保留 unknown
- [x] `src/typesafe-client.ts`：输入字节数/费用记账钩子
- [x] `src/typesafe-client.ts`：`systemOne()` 内建相同载荷缓存（指纹 + TTL + 条数上限），缓存命中不计入延迟均值
- [x] `src/typesafe-client.ts`：`pathTimeoutMs`（默认 800），`timeoutMs` 默认降到 2000
- [x] `src/types.ts` / `cordis.patch.yml` / `README.md`：修默认值不一致（`minScoreThreshold`、`maxTools`）
- [x] `tests/resilience.spec.ts`：断言改为 guarded fail-closed / 非 guarded fail-open，保留 `onError: 'allow'` 兼容
- [x] `tests/loop-guard.spec.ts`：新增低置信度、精确重复、清链、内存上限、unknown 用例
- [x] `tests/safety-guard.spec.ts`：新增缺失概率、headless ask、硬拒集、自定义规则用例

## Phase 2 — 实测度量与标定

- [x] `src/metrics.ts`：删除 `TOKENS_PER_PRUNED_TOOL` / `TOKENS_PER_INTERRUPTED_LOOP`；改为「精确移除字符数 + `ctx.tokenMeter.estimateMessage` 定价」，无估算器时回退到公开的 `FALLBACK_CHARS_PER_TOKEN`，并在 `tokenSource` 标明口径
- [x] `src/metrics.ts`：新增 `inputBytes` / `estCostUsd` / `decisionErrors`
- [x] `src/decisions.ts`：决策追加到 `~/.dsh/jev-decisions.jsonl`
- [x] `bench/cases.jsonl` + `bench/run.ts`：30 条正负样本 A/B，输出 FP/FN/准确率/延迟；费用字段留空（bench 直连客户端，会话费用走线上指标，已在 calibration 注明）
- [x] `src/index.ts` + `src/client.ts` + `src/bench-summary.ts`：看板/`/api/dsh-jev/stats`/`jev_stats` 改为实测口径，并附最近一次 bench 摘要（未跑过时明确说明）

## Phase 3 — 决策原语与 skill 路由

- [x] `src/ask-tools.ts`：注册 `jev_ask` / `jev_rank` / `jev_check`
- [x] `src/skill-router.ts`：复用评分逻辑做 skill Top-1 路由（advisory）

## Phase 4 — 语义结果整形（opt-in）

- [x] `src/result-shaper.ts`：超阈值内容由 Jev 语义选段，默认关闭，失败原样返回
- [x] `docs/calibration.md`：记录 `toolResultPruner` 组合方式 spike 结论

## Phase 5 — 文档与发布

- [x] `README.md`：新增「与 DSH 内置能力的分工」一节
- [x] `README.md`：同步全部新增配置项

## Phase 2 补充记录

- [x] bench 支持 `--offline` 回放录制答案；30 条样本 0 误报、准确率 0.933
- [x] 每次判决写入 `~/.dsh/jev-decisions.jsonl`（含 pass 负样本）

## Phase 5 补充记录（发布收口）

- [x] `package.json` 版本升至 `0.2.0`：本次含破坏性配置变更（移除 `stuckSeverityThreshold`、`safetyGuard` 默认改为 fail-closed、指标文件 schema 升到 v2）
- [x] README 新增「从 0.1.0 升级到 0.2.0」迁移表（三项需检查的变更 + 兼容开关）
- [x] `exports` 补齐 `decisions` / `bench-summary` / `ask-tools` / `skill-router` / `result-shaper`，README「方式 3」同步为可按需挂载
- [x] 打包校验：`npm pack --dry-run` 56 个文件，5 个新模块均在包内；各子模块 import 冒烟通过

## Phase 5 补充记录（部署闭环，Round 9 实测发现）

问题：`sync:desktop` 把构建产物同步到了 desktop profile，但会话里跑出来的指标仍是 v1 schema、`loopGuard` 仍在写 `estimatedTokensSaved` —— 说明**运行中的进程没有加载新构建**。

排查结论：

- 只有 `~/.dsh/profiles/desktop/node_modules/dsh-jev` 装了插件，同步位置本身没错（13 个 lib 文件哈希一致）
- desktop profile 的组合里**没有挂载 HMR 插件**（`desktop.cordis.yml` / `cordis.patch.yml` 均无 hmr 引用），因此文件替换不会触发重载
- 判定方法：`~/.dsh/jev-stats.json` 的 `"version"` —— v1 即旧构建在跑，v2 即 0.2.0

改进：

- [x] 新增 `scripts/sync-profiles.js`：自动发现**所有**已安装该插件的 profile 并逐个同步（旧的 `sync:desktop` 硬编码单 profile，多 profile 部署会漏掉其余）；支持 `--dry-run` 与 `--profile <name>`；结束时打印「需重启」提示
- [x] `package.json`：新增 `sync`（全部 profile），`sync:desktop` 改为脚本的 `--profile desktop` 调用
- [x] `tests/sync-profiles.spec.ts`：5 个用例覆盖 home 解析、profile 发现、全量同步、单 profile 过滤、dry-run 不写盘
- [x] README 新增「让改动在本机生效」：同步命令 + 必须重启 + 用 `jev-stats.json` 的 version 字段判定是否生效

## Phase 5 补充记录（部署自检，Round 10）

「同步了但没生效」是静默失败：宿主没有 HMR，进程继续跑启动时导入的旧构建，而磁盘上已是最新文件。用一条命令把它变成可见结论。

- [x] 新增 `scripts/doctor.js`：逐 profile 比对构建哈希与安装版本，读取 `~/.dsh/jev-stats.json` 的 schema 版本，输出 `ACTION:` / `OK:`；`--json` 供 CI，退出码 0 表示宿主已在用当前构建
- [x] `package.json` 新增 `pnpm run doctor`
- [x] `tests/doctor.spec.ts`：5 个用例覆盖构建漂移/缺文件、v1 与 v2 schema 判定、需重启、已就绪、版本漂移
- [x] README「让改动在本机生效」补充 `pnpm run doctor` 用法
- [x] 实机自检结论：`profile desktop: version 0.2.0 · build in sync` + `running host: metrics schema v1` → `ACTION: restart DSH`（符合预期：同步已完成，重启为用户侧动作）

## Phase 5 补充记录（发布卫生，Round 11）

- [x] 新增 `CHANGELOG.md`（Keep a Changelog 体例）：0.2.0 的 Added/Changed/Removed/Fixed 逐条对应实际提交，并明确 0.1.0 是「阈值未标定、出错即放行」的基线
- [x] 新增 `.github/workflows/ci.yml`：Node 22 与 24 矩阵跑 `install --frozen-lockfile → build → test → bench:offline → 打包校验`；基准走离线回放，无需 API Key，误报或准确率 < 0.9 即失败
- [x] `package.json` 的 `files` 纳入 `CHANGELOG.md`；README 加 CI 徽章与 changelog 链接
- [x] 本地验证：工作流 YAML 可被解析（1 job / 8 steps / matrix [22,24]）；CI 中的打包校验脚本本地执行通过（56 个文件，9 个必需模块齐全）

## Phase 5 补充记录（可复现性，Round 12）

用**全新 clone** 跑 CI 等价流程，替代依赖本机 node_modules 的验证，发现两个真缺陷：

- [x] `pnpm install --frozen-lockfile` 在干净 clone 中**直接失败**：`package.json` 的 devDependencies 范围（`@types/node ^22.13.0`、`typescript ^5.7.0`）与 lockfile 记录的（`^22.20.3`、`^7.0.2`）不一致 → 已把 manifest 对齐到 lockfile 锁定的、实际经过全部构建验证的工具链
- [x] `peerDependencies` 的 `@deepseek-ai/cordis` 未进 lockfile（该 peer 是后加的，lockfile 未重新生成）→ `pnpm install --lockfile-only` 重建，importer 现含 `@deepseek-ai/cordis@4.0.2`
- [x] 新增 `.gitattributes`（`* text=auto eol=lf`）：仓库里 `lib/` 是提交的构建产物，Windows 上 `core.autocrlf=true` 会让这些文件在内容完全一致时也显示为已修改，进而混入后续提交
- [x] 干净 clone 验证通过：`install --frozen-lockfile` → `build` → `test`（70/70）→ `bench:offline`（93.3%、误报 0、退出码 0）
- [x] 另确认：克隆后重新构建产生的 `lib/` 与提交内容一致（`git diff --stat` 无 `lib/` 条目），即提交的构建产物不是陈旧的

## Phase 5 补充记录（文档一致性，Round 13）

把「文档不得说谎」变成机械检查时，立刻抓到一处真实谎报，并顺带得到防漂移的回归。

- [x] 抓到并修复：README 写 `timeoutMs` 默认 `10000`，代码早在 Phase 1 已改为 `2000`（现补上 `pathTimeoutMs` 800 与 `cacheTtlMs` 30000 的说明）
- [x] 各模块默认值抽成导出常量（`DEFAULT_*`），代码内部改用它，消除「文档一个数、代码另一个数」的空间
- [x] 新增 `tests/docs-consistency.spec.ts`：从 README 与 `docs/calibration.md` 反解文档中的数字，与代码常量逐一比对；同时断言无数字默认值的项（`onError`/`onUncertain`/`deferExactRepeats`/`resultShaper`）被显式写明
- [x] 测试数 70 → 76

## Phase 5 补充记录（CI 与兼容性声明，Round 14）

- [x] 用 **bash 5.3.9** 逐条执行 `.github/workflows/ci.yml` 的 `run:` 块（此前只验证过其中的 JS 载荷）：`install --frozen-lockfile` → `build` → `test` → `bench:offline` → 多行 `node -e` 打包校验，输出 `ALL CI STEPS PASSED`（57 个文件入包）
- [x] 收紧未经测试的兼容性声明：`engines.dsh` 由 `>=0.1.0` 改为 `>=0.1.5-rc.2`（插件挂载的 `tools.guard()`、`system-prompt/assemble`、`agent/pre-step` 及可选 `tokenMeter`/`skills`/`toolResultPruner` 仅在该版本验证过），README 增「兼容性」一节
- [x] 修掉 bench 的副作用：`bench --offline` 此前会覆写看板使用的 `~/.dsh/jev-bench.json`，把实测延迟换成 0ms；现仅真实 API 跑动才镜像，离线结果只留在 `docs/calibration/`
- [x] CHANGELOG 结构修正（条目归入 0.2.0 的 Changed 段，而非落到 0.1.0 之后）
- [x] 实测确认：live 跑动镜像 `offline=false / latencyMeanMs=305`，随后 `bench:offline` 不再改动该文件

## Phase 5 补充记录（看板完整性，Round 15）

审计「看板是否展示插件真正测量的一切」，发现 `resultShaper` 有指标却**完全没有任何展示**——用户开启后得不到反馈。

- [x] `metrics.ts` markdown 看板新增「语义结果整形」行（整形次数 + 精确移除字符）
- [x] `client.ts` 设置面板新增对应卡片（整形次数 / 精确移除字符 / 启用状态）
- [x] 新增 `tests/metrics-surface.spec.ts`（3 个用例）：从 `MetricsCollector` 快照与 `BenchSummary` 接口反解数据结构，与看板源码里读取的字段双向比对——既禁止读取不存在的字段（会静默显示 0），也禁止有指标无展示
- [x] 验证测试有效：把 resultShaper 卡片从副本中去掉后，该用例确实报 `missing: resultShaper`
- [x] README 看板示例同步补上该行；测试数 76 → 79

## Phase 5 补充记录（真实 runtime 集成校验，Round 16）

此前所有守卫验证都用**手写假 context**，无法发现事件名错误、参数顺序错误或决策结构被真实分发器拒绝。新增在真实 DSH runtime 上的集成校验。

- [x] 新增 `tests/integration-dsh.mjs`：从 `$DSH_HOME`（默认 `~/.dsh`）定位真实 `@deepseek-ai/cordis`，在其中挂载 client/loop-guard/safety-guard/tool-pruner，然后驱动**真实 waterfall**
- [x] 校验项（7 条）：`ctx.get('typesafe')` 与 `ctx.typesafe` 两条解析路径；`tools/post-execute` 真实 waterfall 产出 loop-guard 提示且 `source.plugin` 正确；`tools/pre-execute` 真实 waterfall 拒绝 `rm -rf /`；良性调用仍能到达下游监听者；`system-prompt/assemble` 真实 waterfall 把工具面 4 → 2；返回对象保留 harness 不变量要求的字段
- [x] 写这个校验时立刻纠正了我自己的两个错误假设：Cordis 的 plugin fiber **异步**启动（需让出一拍再解析服务）；tool-pruner 是**原地修改** `assembly.tools`，因此原始长度必须在 waterfall 之前取
- [x] 无 DSH 时打印 `SKIP` 并退出 0（CI 无 DSH 也安全）；新增 `pnpm run verify:dsh`

## Phase 5 补充记录（宿主加载契约，Round 17）

验证「宿主在加载期会强制的两件事」，此前完全没有测试覆盖：

- [x] **UI bundle 必须能被当作经典脚本加载**：新增校验用 `vm.Script` 解析 `lib/client.js`（ESM 语法会直接抛错，等价宿主的拒绝行为），并断言不含 `import`/`export`；`scripts/bundle-client.js` 剥离 ESM 导出这一步此前无人验证
- [x] **UI 模块协议与面板注册契约**：在 `vm` 沙箱中提供 `window.__ModuleLoader__`，执行 bundle 拿到注册项，断言 `id === 'dsh-jev'`；用最小 react stub 调用 `factory(require)`，断言导出 `apply` 函数与 `inject === ['slots']`；再以假 host ctx 调用 `apply`，断言通过 `effect` 安装样式、并且注册的 slot 为 `settings.section` / `id: 'jev'` / `order: 25` / 组件为函数
- [x] **`cordis.patch.yml` 的键必须存在于 TS 类型**：DSH 遇到未声明的配置键会**拒绝加载插件**，一个拼写错误就会让所有用户挂掉；校验从 `src/types.ts` 反解 42 个已声明字段，与 patch 文件里 `config:` 的直接子键比对（已验证有牙齿：把 `loopGuard` 写成 `loopGard` 会报出 `loopGard`）
- [x] **manifest 指向的文件必须存在**：`main`/`types`/`dsh.bundle.patch`、`exports` 的每个 `default` 与 `types` 目标、`lib/client.js` 必须随包发布、`dsh.client.inject` 必须含 settings slot
- [x] 新增 `tests/packaging.spec.ts`（4 个用例），测试数 79 → 83

## Phase 5 补充记录（前缀稳定性，Round 18）

落实设计阶段标记的 KV cache 风险（D5/D6 讨论中列出但未实现的一项）。

- [x] `tool-pruner` 此前返回 `[...alwaysRetain 全部提前, ...selected 按分数排序]`：既改变了与未剪枝路径同一集合下的顺序，也让尾部随每轮分数漂移——工具块位于请求前部，任何变化都会让可复用前缀失效
- [x] 改为保持候选原序：选择只决定「哪些工具留下」，不决定排列（`candidates.filter(t => keep.has(t))`，用对象集合精确匹配）
- [x] 新增 3 个用例：入选集合不变但顺序必须等于输入序（分数最高者在最后）；`alwaysRetain` 工具不得被提到最前；候选数已满足 `maxTools` 时返回**同一个数组**且不调用模型
- [x] README 配置参考补充「顺序稳定性」说明；CHANGELOG 记录该行为变更
- [x] 测试数 83 → 86

## Phase 5 补充记录（发布物默认配置，Round 19）

审计「随包发布的默认配置 vs 库默认值」，发现一处安全回归：

- [x] `cordis.patch.yml` 的 `guardedTools` 只列了 `bash`/`pwsh`/`terminal`/`run_command`/`run_code` 五个 shell 工具，而库默认（8 个）与 README 都包含 `write_to_file`/`replace_file_content` —— 默认安装下**文件写入完全不做语义门禁**，凭据被写进仓库文件时无人拦截
- [x] 已把随包清单补齐为与库默认一致（+`execute_command`、`write_to_file`、`replace_file_content`）
- [x] 新增 2 个回归用例：随包 `guardedTools` 必须 ⊇ 库默认（且必须含两个文件写入工具）；随包 `alwaysRetain` 必须 ⊇ 库默认，防止后续编辑悄悄缩小保护面
- [x] 已验证有牙齿：对修复前的 5 项清单，检查会报出 `execute_command, write_to_file, replace_file_content`
- [x] README 明确列出该清单；CHANGELOG 记录；测试数 86 → 88

## Phase 5 补充记录（waterfall 委派回归，Round 20）

审计「每个 waterfall 监听器是否都把决策交还下游」——在真实 cordis 上驱动 `agent/pre-step` 时抓到**本轮最严重的问题**。

- [x] **缺陷（Phase 1 引入）**：`loop-guard` 的 `agent/pre-step` 监听器只做清链、不调用 `next()`。waterfall 语义下这会返回 `undefined`，下游决策丢失；DSH 的 agent loop 随即在 `decision.kind` 上抛 TypeError。真实 cordis 实测：`waterfall result: undefined`，下游 `{kind:'enter'}` 未存活。**该版本一旦重启即会让 agent loop 崩溃**
- [x] 修复：`loop-guard` 与 `result-shaper` 的 pre-step 监听器都改为取最后一个参数为 `next` 并 `return next()`；清链/重置预算照旧执行
- [x] 修复后实测：两个监听器均返回下游决策 `{"kind":"enter","messages":["kept"]}`
- [x] 集成校验新增「挂载全部插件时 `agent/pre-step` 决策必须存活」一项（现 8/8），并把 `result-shaper` 一并挂载（此前集成校验漏挂它）
- [x] 单测新增「pre-step 决策原样透传」，并核对代码里全部 7 处事件监听：`agent/pre-step`×2、`tools/post-execute`×2、`tools/pre-execute`×1、`system-prompt/assemble`×2——四类事件现均有真实 waterfall 覆盖
- [x] 测试数 88 → 89

## Phase 5 补充记录（服务层决策规范化，Round 21）

前一轮的集成校验只驱动 `ctx.waterfall`，**绕过了 tools 服务的规范化与不变量**。本轮挂载真实 `dsh-system-prompt` + `dsh-tools`，跑通完整服务级路径（`createExecution` → `prepareExecution` → `postExecute`）。

- [x] **抓到的功能缺陷**：真实 `result.content` 是**块数组**（`[{type:'text',text:...}]`），而 `result-shaper` 要求 `typeof content === 'string'` → 该模块在真实管线里从不生效（单测通过是因为我传了字符串）。新增 `extractText` / `replaceText`：兼容两种形态；块形态下文本块折叠为一个，非文本块保持相对位置（与 DSH 自身 pruner 的约定一致）
- [x] 集成校验新增 3 项（现 11/11）：真实服务把探针调用 prepare 为 `dispatch`；`postExecute` 接受整形决策且**不违反不变量**（1592 → 226 字符）；整形后保留信息行并插入丢弃标记
- [x] 单测新增 2 项覆盖 `extractText` / `replaceText` 的字符串与块形态、非文本块顺序保持、无文本块时追加
- [x] 记录两处踩坑（都属我方脚本）：把守卫挂 root、client 挂子 fiber 会让 `resolveClientFrom` 取不到服务（改用 `apply` 在 root 提供）；PowerShell 双引号里的 `\n` 是字面量，导致替换的赋值行被写进注释、mock 返回空答案
- [x] 测试数 89 → 91

## Phase 5 补充记录（服务级安全属性与真实装配，Round 22）

- [x] **拒绝的真实语义**：服务级验证「拒绝意味着工具体从不执行」——`prepareExecution` 返回 `post-result`、`result.isError=true`、原因指名确定性策略，且 `execute()` 调用次数**为 0**。此前只断言了决策本身（`kind==='deny'`），未断言工具是否真的没跑
- [x] **真实 `systemPrompt.assemble()`**：挂载真实 `dsh-system-prompt` + `dsh-tools` 并注册 4 个工具，调用真实装配流程——不抛不变量错误，工具面被剪到 2（`read_file,write_file`）。此前剪枝只在假 assembly 上验证过，而 `dsh-system-prompt` 自带不变量校验（非空名称、text 必须为字符串等）
- [x] 自查并删除一条**恒真检查**（断言体写成 `prepared => prepared`，函数对象恒为真）；同一属性由下一条 `executed === 0` 断言覆盖
- [x] 集成校验 11 → **14/14**

## Phase 5 补充记录（单调守卫属性，Round 23）

验证「后续监听者无法强制放行」这条设计承诺——此前只验证了「决策是 deny」，未验证它在链路中的**优先级**。

- [x] 探明 cordis 服务可见性：**根 ctx 能看到子插件提供的服务**（`ctx.get('typesafe')` 为真），但**兄弟插件之间看不到**（各自需向根查找）。据此确认我的集成 harness（守卫挂在根、服务由子插件提供）与 DSH 加载器的组合方式一致，此前的 harness 假设成立
- [x] 新增集成校验：在守卫之后注册一个「一律放行」的 `tools/pre-execute` 监听器，再对 `rm -rf /` 发起调用 —— 结果 `prepared.kind=post-result`、`executed=0`，且该放行监听器**运行次数为 0**
- [x] 结论：`ctx.tools.guard()` 的单调拒止发生在可扩展 waterfall **之前**并短路链路，因此不止「无法覆盖」，而是「根本不会执行到」——设计承诺成立且更强
- [x] 集成校验 14 → **15/15**

## Phase 5 补充记录（四个插件的服务级覆盖闭环，Round 24）

- [x] **loop-guard 提示经真实服务送达**：`createExecution` 接受普通对象作为 agent，`postExecute` 返回的 `additionalContexts` 长度 1 且 `source.plugin === 'typesafe-loop-guard'`——此前该项只在裸 waterfall 上验证
- [x] 至此四个插件**全部**具备服务级（真实 `dsh-tools` + `dsh-system-prompt`）覆盖：safety-guard 的拒止与单调性、tool-pruner 的真实装配、result-shaper 的块内容整形、loop-guard 的提示送达
- [x] 集成校验 15 → **16/16**；无 DSH 时整体跳过并退出 0

## Phase 5 补充记录（验证工具污染实机信号，Round 24）

`pnpm run doctor` 用 `~/.dsh/jev-stats.json` 的 schema 版本判断宿主是否已重载。实测发现该信号会被**我自己的验证脚本**改写——一次 doctor 误报 `OK` 由此而来。

- [x] 复现：集成脚本运行前 `version 1 / mtime 04:20:45`，运行后 `version 2 / mtime 04:20:46`（脚本导入插件即构造 `defaultMetrics`，判决时以 v2 schema 覆写实机文件；随后仍在运行的旧宿主又写回 v1，导致结论来回翻转）
- [x] `metrics.ts`：新增 `METRICS_PATH_ENV`（`DSH_JEV_METRICS_PATH`）与 `resolveMetricsPath()`；采集器改为**懒解析路径 + 懒加载数据**，构造与读快照都不落盘
- [x] 四个验证脚本（`verify:dsh` / `verify:live` / `verify:tools` / `bench`）设指向 `%TEMP%` 的临时指标文件
- [x] 实测确认：运行集成 + 离线基准后，实机文件仍为 `version 1 / mtime 04:22:23`（分毫未动）
- [x] 单测 +3：路径覆盖优先级（显式 > 环境 > 默认）、构造与读快照不创建文件、环境变量重定向落盘
- [x] 测试数 91 → 94

## Phase 5 补充记录（决策日志污染，Round 25）

上一轮修掉指标文件污染后，检查同一类问题是否存在于**决策日志**（`~/.dsh/jev-decisions.jsonl`，阈值复核所用标定数据集）。

- [x] 复现：一次集成校验向实机日志追加 **6 条 mock 判决**（1841 → 1847 行），末条 `module=loop-guard`——复核阈值时会读到植入数据
- [x] `decisions.ts`：新增 `DECISIONS_PATH_ENV`（`DSH_JEV_DECISIONS_PATH`）与 `resolveDecisionsPath()`；`DecisionLog` 改为懒解析路径，构造与读取都不创建文件
- [x] 三个会记录判决的脚本（`verify:dsh` / `verify:tools` / `verify:live`）设指向临时日志
- [x] 实测确认：运行集成校验前后实机日志均为 **1847 行**（未追加）
- [x] 单测 +3：路径覆盖优先级、构造与读取不落盘、环境变量确实隔离验证判决
- [x] 测试数 94 → 97

## Phase 5 补充记录（单测套件污染，Round 25 续）

- [x] 发现：`pnpm test` 自身就会写实机文件——`tests/client.spec.ts` 经真实 `TypeSafeClient` 触发 `defaultMetrics.recordCall`，把 **v2 指标**写进 `~/.dsh/jev-stats.json`。这造成一次瞬时 `version 2` 读数，几乎让我误判「宿主已重载」；随后旧宿主写回 v1，doctor 才给出正确结论 `ACTION: restart DSH`
- [x] 修复：新增 `tests/isolate.mjs`，由 `node --import ./tests/isolate.mjs` 在 spec 之前预载，把两个环境变量指向临时目录
- [x] 实测：运行 97 个测试前后，实机指标 `version 1 / mtime 04:25:42` 不变；决策日志 1931 行不变
- [x] 新增守卫单测：断言预载确实生效（`METRICS_PATH_ENV` 与 `DSH_JEV_DECISIONS_PATH` 已设且不指向 `.dsh/`），若将来 `test` 脚本丢掉预载会立刻失败
- [x] 测试数 97 → 98

## Phase 5 补充记录（文档数字与 CI 复核，Round 26）

- [x] 清理文档中的**过期数字**：README 写「57 个用例」、calibration 写「70/70」，实际已 98；改为不再写死的表述（「用例数随版本增长，以输出为准」），避免每次发版都要改文档
- [x] 复核改动后的 `test` 脚本（新增 `node --import ./tests/isolate.mjs`）在**全新 clone** 中成立：install → build → 98/98 → bench（93.3%、误报 0、退出码 0）
- [x] 干净 clone 的整轮运行后，实机状态仍未被动过（指标 `version 1` + mtime 不变、决策日志行数不变），确认预载隔离在 CI 式环境下同样生效
- [x] 说明：此前用 bash 逐条复演 CI `run:` 块的做法本轮被拒（命令未执行），改以干净 clone 直接跑等价步骤验证

## Phase 5 补充记录（决策字段语义澄清，Round 27）

- [x] 无遗留 TODO/FIXME（`src` / `scripts` / `tests` 全量扫描，唯一命中是测试夹具里的字符串 `grep -rn TODO src`）
- [x] 澄清 `loop-guard` 同时写 `contexts` 与 `additionalContexts` 的理由：实测宿主 `dsh-tools` 只合并 `additionalContexts`，`contexts` 仅供读旧键的宿主使用；代码注释与 `types.ts` 均写明，并保证两者承载**同一条**提示（不会重复注入）
- [x] 收紧断言：集成校验原先用 `contexts ?? additionalContexts` 回退，无法分辨哪个键真正生效；现改为断言**服务实际合并的那个键**（输出 `additionalContexts=1`）
- [x] 新增单测：两个键各含 1 条且 `id` 相同（防止未来出现双份注入）
- [x] 测试数 98 → 99

## Phase 5 补充记录（skill 路由的服务级覆盖，Round 28）

`skill-router` 是最后一个缺服务级覆盖的模块——它依赖真实 `ctx.skills` 的目录形状与规模，与此前「字符串 vs 块内容」「contexts vs additionalContexts」同类假设，从未在真实注册表上验证。

- [x] 实测真实注册表：`ctx.skills.list({})` 返回 **112 个 skill**，摘要字段为 `name,path,description,invocation,source,provider,resourceBase`——与 `SkillSummary` 一致（`whenToUse` 为可选，首个条目就没有该字段，代码按可选处理 ✓）
- [x] 集成校验新增 3 项（现 **18/18**）：真实目录满足路由消费的形状；装配后恰好一条 `typesafe-skill-router` 建议且文案含「looks directly applicable」；再次装配不会堆叠第二条
- [x] README 补充该模块语义：同一意图只建议一次（指纹相同即跳过，既不重复调用模型也不重复注入）；每轮装配最多一条同名条目；`skills.list()` 抛错时 prompt 原样返回
- [x] 至此**五个模块全部具备服务级（真实 DSH 服务）覆盖**

## Phase 5 补充记录（安装指令实测，Round 29）

验证 README 里**最主要的安装指令**是否与已安装 CLI 的真实语法一致（此前只验证了 manifest 结构，未实测命令）。

- [x] 实测 `dsh plugin --profile desktop --help` → **被拒**：`error: profile "desktop" is managed exclusively by the Electron application`。而 desktop 正是本部署使用的 profile——照抄文档只会拿到报错且无任何指引
- [x] 实测 `dsh plugin --profile headless`（无子命令）→ `error: plugin needs pnpm arguments to forward (e.g. add <package>)`，确认 `dsh plugin` 本身不含子命令，而是把参数**转发给该 profile 目录下的 pnpm**（`add`/`remove`/`list` 均为 pnpm 语义）
- [x] README 补两条须知：desktop profile 由 Electron 应用独占、桌面端应走应用内入口或 `pnpm run sync` 同步路径；`dsh plugin` 的转发语义
- [x] 结论：`dsh plugin --profile headless add <pkg>` 的写法本身正确，缺的是对 desktop 的警告

## Phase 5 补充记录（UI 与宿主路由契约，Round 30）

- [x] 补齐最后一处跨文件契约：设置面板抓取的端点（`src/client.ts` 的 `/api/dsh-jev/stats`）必须与 `src/index.ts` 注册的 connection 路由、webServer 路由**完全一致**——不一致时面板只会静默空白，没有任何报错
- [x] 新测试同时断言构建产物 `lib/client.js` 里也带同一端点（防止改源码忘了重新构建面板）
- [x] 测试数 99 → 100

## Phase 5 补充记录（验证报告，Round 31）

- [x] 新增 `docs/verification-report.md`：把散落在 calibration / plan / CHANGELOG 的验证结论收成**证据索引**——承诺 → 验证手段 → 结果，并单列 **15 个真实缺陷及其「由哪种验证手段抓到」**
- [x] 报告同时写明 4 项**主动保留的限制**（2 条漏报为设计取舍、基准不报费用、resultShaper 默认关闭、实机端到端待重启）与自行复现命令
- [x] README 文档索引加入该报告；重启后的确认步骤（`doctor` 期望输出 + `version` 1→2）写在其中
- [x] 该文件同时回答了一个方法论问题：本轮 15 个缺陷中，**跨层集成校验（真实 cordis / 真实 dsh-tools）抓到 3 个单测结构上无法发现的**（agent loop 崩溃、整形模块失效、服务规范化）

## Phase 5 补充记录（CI 覆盖跳过路径，Round 32）

- [x] CI 新增一步 `pnpm run verify:dsh`：GitHub runner 上无 DSH runtime，因此这一步**专门行使跳过路径**（必须打印 `SKIP` 并退出 0，而不是失败）。此前该路径只在第 16 轮手工验证过一次，任何让「无 DSH 时失败」的改动都不会被发现
- [x] 与真实 runtime 的行为仍由装有 DSH 的机器运行同一脚本覆盖（18 项检查）
- [x] 工作流 YAML 复核：6 个 `run` 步骤，顺序为 install → build → test → bench → verify:dsh → 打包校验

## Phase 5 补充记录（隔离守卫与快照措辞，Round 33）

- [x] 新增 `tests/isolation.spec.ts`（4 项）：静态断言**每个会触发判决的脚本**都设置了 `DSH_JEV_DECISIONS_PATH`、**每个会记录调用的脚本**都设置了 `DSH_JEV_METRICS_PATH`，且用 `??=` 不覆盖调用方已设的值；另断言 `test` 脚本仍预载 `tests/isolate.mjs`。此前只有单测侧被守护，四个独立脚本若丢失重定向行无人发现
- [x] 已验证守卫有牙齿：把 `bench/run.ts` 的重定向行去掉后，检查会报出「missing metrics redirect」
- [x] 验证报告补「快照」说明：文档写死数字本身是此前发现过的缺陷类型，故明确标注数字会随版本增长、以命令输出为准
- [x] 测试数 100 → 104

## Phase 4 补充记录（整形的真实效力实测，Round 34）

首次在真实模型上检验整形提示词能否区分信息块与噪声块，结果推翻了该模块的可用性假设。

- [x] 实测：600 行构建日志（仅一块含真实报错）→ 两种问法（`noul` 0.34–0.36、比较式 `score` 0.75–0.84）分布**完全平坦**，报错块 0.35 / 0.78 均处中位 → 按阈值必然「全丢弃」，连报错一起丢
- [x] 修复 1：`looksRepetitive` 原先只认逐字节重复，构建日志/依赖树/编号清单（实测 32KB、35KB）全被拒；现改为「单行 >4000 字符 / 行数 ≥120 / 结构重复率 ≥50%（数字与长十六进制归一后）」
- [x] 修复 2：整形请求超时太紧（沿用 800ms 的 `pathTimeoutMs`），500 行输入实测直接中止；新增 `requestTimeoutMs`（4000ms）与 `blockPreviewChars`（600，原先每块 1500 字符使 24 块请求达数十 KB）
- [x] 修复 3：新增 `spreadThreshold`（0.15）——分布不可分即拒绝整形、原样返回。模块在无判据时不动作，而非随机删块
- [x] 文档：`docs/calibration.md` §9 记录两次实测数字与结论；README/CHANGELOG 标注该模块为**实验性**并说明当前会拒绝动作
- [x] 单测：重写重复性判定用例（固定新语义）、新增「分布平坦即拒绝 / 分布可分仍整形」；测试数 104 → 105

## Phase 4 补充记录（整形问法穷举与成本守卫，Round 35）

- [x] 穷举四种更锋利的问法，验证「换问法能否让整形可用」：冗余式 `noul`（0.08–0.19）、可行动式 `noul`（0.03–0.05，对字面写着 `ERROR ... TS2345` 的块也给 0.04）、单赢家 `choice`（选 `block_9`，正确为 8，confidence 0.81 **自信选错**）
- [x] 单赢家 `choice` 的可靠性再验：依赖树（告警埋在 600 行）选对；**纯噪声（无信息块）仍以 0.77 置信度作答** → 该问法不是信息量的可靠信号
- [x] 结论：五种问法在这类输入上都无法可靠定位 → 不是措辞问题，而是「哪一部分重要」属于需要理解的任务，超出 Jev 的有界分类能力
- [x] 据此新增成本守卫：分布平坦导致拒绝后，**同一轮内不再重试整形**（`declinedThisTurn`，`agent/pre-step` 清除），避免把第二次预算花在同一个无解问题上
- [x] `docs/calibration.md` §9.2 记录全部五组测量（含纯噪声反例），§9.3 更新结论与建议
- [x] 测试数 105 → 106

## Phase 4 补充记录（整形器重写，Round 36）

第 34/35 轮的结论（「Jev 无法完成这类判断」）被对照实验**推翻**，根因是请求打包方式。

- [x] 对照实验：裸文本错误行 → `kind=error` confidence **1**、`is_failure=0.98`；进度行 → `kind=progress` conf 1。**Jev 分类单行完全可靠**
- [x] 根因：把 N 项塞进 `state` 再用 `kind_N`/`keep_N` **按索引指代**，模型无法绑定 → 全部问题同一答案。仓库里工作正常的 `tool-pruner` 正是把候选描述写进各自问题（`score_<name>`）
- [x] 可行设计实测：行形状聚类 + 每类一条**内容嵌入问题**的代表行 → 构建日志 4 簇（error/stack 判 `failure` conf 1、进度判 `routine_progress` conf 1）、依赖树 3 簇（WARN 判 `warning` conf 1）、测试运行 3 簇（`not ok`/`AssertionError` 判 `failure`）、纯噪声 1 簇（无保留类别 → 拒绝）
- [x] 据此重写 `src/result-shaper.ts`：判定单元由「17–24 块 × 600 字符」变为「1–4 条问题」；配置项随之替换为 `keepKinds` / `minKindConfidence` / `maxClusters` / `sampleChars` / `requestTimeoutMs`
- [x] 保留的守卫：类别全被丢弃即拒绝且本轮不再重试、答案不可用即保留、超出 `maxClusters` 的类别一律保留、内容未变小即返回原文、失败结果与下游改写不覆盖
- [x] 测试重写（12 项）；集成脚本 mock 改为回答 `kind_*` 并按真实测量把栈帧也判为 failure；测试数 106 → 107，集成 18/18
- [x] `docs/calibration.md` 新增 §9.3（对照实验）与 §9.4（可行设计实测表）

## Phase 5 补充记录（提问绑定守卫，Round 37）

把第 36 轮的核心教训固化为**可回归的守卫**，并审计其余模块是否也犯了同一错误。

- [x] 审计四处「逐项提问」：`tool-pruner`（`score_<tool>`）、`skill-router`（`skill_<name>`）、`result-shaper`（`kind_<i>`）、`ask-tools` 的 `jev_rank`（`rank_<id>`）——**四者都已把项内容嵌入问题**，只有整形器此前违规（已修）
- [x] 新增 `tests/question-binding.spec.ts`（4 项行为断言）：每处逐项提问必须满足 (a) 各问题指令**两两不同**，(b) 每条指令包含**自己那项**的区分性文本（工具名/技能描述/行样本/候选标签）
- [x] 已验证守卫对两种回归形态都有牙齿：① 问题完全相同（旧块设计）→ 被 (a) 捕获；② 只写索引不写内容（第 35 轮的探针）→ 被 (b) 捕获；③ 当前实现 → 两者均通过
- [x] 四处代码加上指向 `docs/calibration.md §9.3` 的规则注释，避免后来者重新走一遍
- [x] 测试数 107 → 111

## Phase 4 补充记录（重写后的线上验证，Round 38）

- [x] 新增 `tests/live-shaper.ts` + `pnpm run verify:shaper`：把**重写后的实现**（而非一次性探针）在真实模型上跑四类输出——构建日志 32.7KB → 253 字符（保留 error+stack）、依赖树 27.8KB → 181 字符（保留 WARN）、测试运行 11.9KB → 203 字符（保留 `not ok`+`AssertionError`）、纯噪声 → 拒绝且未发起请求（0ms）
- [x] 压缩比约 130×–190×，四类场景的保留/丢弃目标全部命中
- [x] 该脚本纳入 `tests/isolation.spec.ts` 的守卫名单（会记录调用，必须重定向实机状态）
- [x] README 验证命令清单加入 `pnpm run verify:shaper`；`docs/calibration.md` 新增 §9.6 记录实现级结果

## Phase 2 补充记录（工具剪枝的线上排序验证，Round 39）

- [x] 补充覆盖缺口：`tool-pruner` 默认开启且会移除模型可见的工具，此前只有不含断言的 `live-e2e.ts`
- [x] 新增 `tests/live-pruner.ts` + `pnpm run verify:pruner`：6 个标注用例（14 个候选工具、`maxTools: 4`、纯排序），每个用例断言「必须留下的」全部留下、「必须剔除的」全部剔除
- [x] 实测 6/6 通过，必需工具**零遗漏**；保留数常少于 `maxTools`（不相关项被阈值滤掉而非凑数）；延迟 253–700ms
- [x] 纳入 `tests/isolation.spec.ts` 守卫名单与 README 命令清单；`docs/calibration.md` 新增 §10
- [x] 覆盖缺口仅剩 `skill-router` 的线上（真实模型 + 真实 112 项目录）路由质量

## Phase 3 补充记录（skill 路由的线上质量，Round 40）

补上最后一个覆盖缺口：`skill-router` 此前只有 mock 的服务级覆盖，从未在真实模型 + 真实 112 项目录上测过。

- [x] **抓到生产级缺陷 1（静默空转）**：`route()` 对 112 个问题的请求沿用 800ms 的 `pathTimeoutMs` → **7/7 用例全部超时**（805–815ms）。`apply` 会捕获错误后「不带建议继续」，因此这个默认开启的模块在生产中从不给建议。把客户端 `timeoutMs` 提到 4s 仍无效——`route()` 显式用 `pathTimeoutMs`。修复：路由自有 `requestTimeoutMs`（默认 4000ms；实测 112 问题需 1.36–1.45s）
- [x] **抓到真实缺陷 2（确定信号被淹没）**：「对这个新产品做一次 SWOT 分析」在目录含 `swot-analysis` 的情况下选中 `company-intel`（1.77 / conf 0.65）。修复：`nameMatchBoost`（默认 0.6，请求字面点名技能时加分），生效后选中正确技能
- [x] 新增 `tests/live-router.ts` + `pnpm run verify:router`：7 个标注用例，**6 PASS + 1 条已记录的跨语言漏报（`KNOWN`，不计失败）**
- [x] 单测 +3：字面点名压过更高分对手、连字符片段算点名而无关词不算、候选上限默认关闭且仅在设置时启用
- [x] 新增配置项 `requestTimeoutMs` / `nameMatchBoost` / `maxCandidates` 并写入 README（含实测依据）；`docs/calibration.md` 新增 §11
- [x] 测试数 111 → 114

## Phase 5 补充记录（全模块共存，Round 41）

此前每个模块都是单独挂载验证的；`tool-pruner` 与 `skill-router` 同挂 `system-prompt/assemble`，`loop-guard` 与 `result-shaper` 同挂 `tools/post-execute` —— **共存从未验证**。

- [x] 新增集成校验（4 项）：把 client / loop-guard / safety-guard / tool-pruner / result-shaper / skill-router **全部挂在同一个真实 Context 上**，注册 4 个工具与真实 112 项技能目录，然后断言四件事同时成立：剪枝仍生效（4 → 2）、路由仍给建议（1 条）、整形仍替换内容、死循环提示仍搭在同一条决策上
- [x] 结论：**共存无冲突**（结果 22/22 通过）
- [x] 排查过程中的一次自我纠错：首轮 `advice=0` 看似共存缺陷，实为我的集成 mock 缺少 `skill_*` 分支（返回了安全答案 → 无 score → 无建议）。用最小复现脚本确认「剪枝真正发生 + 路由」本身正常后，修正的是 mock 而非产品代码
- [x] 集成校验 18 → 22 项

## Phase 5 补充记录（验证报告刷新，Round 42）

- [x] 全员线上矩阵复跑，六个脚本全绿：`verify:dsh`（22/22）、`verify:tools`、`verify:live`、`verify:shaper`（4/4）、`verify:pruner`（6/6）、`verify:router`（6 PASS + 1 KNOWN）
- [x] 刷新 `docs/verification-report.md`：状态表更新为 114 单测 / 22 集成 / 五个线上脚本；承诺表新增「剪枝排序质量」「行形状分类有效」「路由请求能在预算内完成」「各模块共存互不淹没」四行；缺陷表补入第 40 轮的两个路由缺陷（此前共 15 项，现 17 项）
- [x] 报告新增一类特殊记录：**被推翻的结论**（第 34–35 轮误判「Jev 做不到」，第 36 轮对照实验证明是请求打包错误），并写明教训「『模型做不到』必须先排除『我请求写错了』」
- [x] 「主动保留的限制」补入跨语言路由漏报；复现命令清单补全三个新脚本

## Phase 5 补充记录（交付摘要与最终复现，Round 43）

- [x] `docs/OPTIMIZATION_PLAN.md` 顶部新增「交付摘要」：七个模块各自的职责、默认开关、验证手段与关键实测数字，并指向 verification-report / calibration；清单已 416 行 / 210 项，评审者不必通读
- [x] 在最终提交上重跑干净 clone 全流程：`install --frozen-lockfile` → `build` → `114/114` → `bench:offline` → `verify:dsh`（无 DSH 时正确打印 SKIP）→ 重建后 `lib/` 零漂移
- [x] 结论：交付物不依赖本机残留状态，克隆 + 上述五步即可复现全部离线结论

## Phase 5 补充记录（文档计数守卫，Round 44）

- [x] 自查发现自相矛盾：我在验证报告里写下「文档写死数字本身是一类缺陷」，转身在交付摘要里写死了单测/集成数量。数字会随版本漂移，于是给它加守卫而非删掉
- [x] 判别两类位置：**当前声明**（verification-report 状态表、plan 交付摘要）必须与事实一致；plan 里各轮的历史条目（「集成校验 11 → 14/14」）是执行日志，**故意不校验**
- [x] 单测数可静态精确计数：`tests/*.spec.ts` 中 `^test(` 声明数 = 运行时用例数（实测 114 = 114）。新增 2 项守卫断言，报告与摘要中的数字必须等于该计数
- [x] 集成检查数**无法静态推导**：静态 `check(` 出现 28 处、运行 22 项，差额正是各 `try` 的 catch 兜底检查。改为让脚本自己打印 `checks passed: 22 / 22`，并断言脚本保留该输出行
- [x] 守卫立即生效：新增这两项测试后计数变为 116，文档仍写 114 → 构建失败，据此更新两处文档
- [x] 测试数 114 → 116

## Phase 2 补充记录（bench 扩到三模块 + 工具链类型检查，Round 45）

- [x] **bench 从 2 个模块扩到 5 个**：新增 shaper / pruner / router 各 2 条标注用例（共 36 条），且这三条路径**驱动各自发布的代码路径**（`ResultShaperService` / `ToolPrunerService` / `SkillRouterService`），而不是在这里重新实现规则
- [x] 意义：这三个模块此前只在**需要 API Key 的线上脚本**里验证；现在它们的规则也进了 `bench:offline`，因此**进入 CI**——未来重构破坏它们会在 CI 失败，而不是等某个人手动跑带 Key 的脚本
- [x] 实测：线上记录一次后，`bench:offline` 对 6 条新用例**全部可确定复现**（shaper-build-log 保留 2 簇/丢弃 160 行、pure-noise 拒绝、两条剪枝排序正确、两条路由选对）；总计 36 条、准确率 **94.4%**、误报 0
- [x] **发现并修复工具链盲区**：`bench/`、`tests/`、`scripts/` 不在 `tsconfig.json` 的 include 里，因此**我自己的验证脚本从未被类型检查过**（Node 只做类型剥离）。新增 `tsconfig.scripts.json` 后立刻抓到 2 处类型错误（离线回放的 mock 返回 `Record<string, unknown>` 而非 `QuestionResult`；`state` 未断言为 `SystemOneInput` 允许的形状）
- [x] 新增 `pnpm run typecheck:scripts`，接入 `pretest`（因此 CI 的 `pnpm test` 已覆盖），CI 中另立显式步骤便于定位失败

## Phase 2 补充记录（录制指纹，Round 46）

- [x] 修掉录制-回放体系的一个**静默腐化**风险：`bench:offline` 靠录制的答案支撑 CI，但若某用例的输入被改动而答案未重录，**CI 会拿陈旧答案一路绿灯**（回放与输入无关）
- [x] 录制格式升级为 v2：每条记录保存 `{ fingerprint, answers }`，fingerprint 是**实际请求体**的 sha256 前 16 位；离线回放时用当前用例生成的请求重算指纹并比对，不一致即报「case input changed since it was recorded … re-run `pnpm run bench` to re-record」
- [x] 已验证守卫有牙齿：改动用例里的报错文本后，离线运行确实拒绝该用例（`request e8247c0e49e1674c vs recorded d1e4f9f966c348a6`）
- [x] 顺带修掉两个自身缺陷：① 旧格式条目会被合并进新文件（现改为 live 运行**重写**整份文件）；② 「不发请求的用例」（纯噪声整形）在离线时被无谓判定为缺录制——改为**按需校验**，不调用模型就不需要录制
- [x] 实测：live 记录 36 条交换、34/36 正确（94.4%、误报 0）；离线回放得到**完全相同的数字**

## Phase 2 补充记录（CI 网回归演练，Round 47）

用「注入真实回归」的演练验证 CI 网本身能不能拦住问题，结果发现**两个洞**：

- [x] **洞 1（上一提交已修）**：bench 的整形用例把 `keepKinds` 钉在自己配置里 → 被保护的那个「发布默认值」从未被该用例触及。注入 `DEFAULT_KEEP_KINDS = ['routine_progress']` 后单测失败，bench 却仍通过
- [x] **洞 2（本提交修）**：bench 的通过条件是「误报 0 且总准确率 ≥ 0.9」。回归使某用例判定为 `bad-shape`、准确率降到 0.917（仍 ≥ 0.9）→ **退出码 0**。即单个用例的规则回退可以被总体平均掩盖
- [x] 修法：用例可标记 `knownMiss`（两条已记录的死循环漏报已标记），门槛改为「**任何未标记的失败都失败**」；摘要分别报告 `knownMisses` / `falsePositives` / `falseNegatives`，让「严格数字」与「已记录例外」始终可分
- [x] 演练结果（全新 clone 注入同一回归）：单测 `exit 1` **且** bench `exit 1`，输出 `1 unexpected failure(s); 2 documented miss(es)` —— 两道闸门都会拦下
- [x] 顺带同步文档：CI 注释、README 的 CI 描述、验证报告的基准行（30 → 36 条、94.4%、指纹校验）

## Phase 5 补充记录（守卫网批量回归演练，Round 48）

把第 47 轮的「注入回归」做法系统化：对网里 10 条守卫逐一注入对应回退，检查是否有闸门拦下。**演练本身先暴露了自身缺陷**（单测读构建产物，改 `src` 后不构建就看不见）——补上构建步骤后为 8/10。

余下 2 条未拦住的是**网的真实盲点**（两条测试各自被另一道门挡住，对目标回归不敏感）：

- [x] 盲点 1「低置信度用例」：原用例 `pLoop=0.4` 本就不达 0.6 阈值，**无论 `minConfidence` 如何改都不会触发** → 新增用例把 `pLoop` 提到 0.8、`progress` 降到 0.1，只留置信度一个变量（0.3 必须静默、0.9 必须触发）
- [x] 盲点 2「剪枝顺序用例」：原用例入选集合里「高分者恰好排在前面」，`[...selected]`（按分数）与输入序**恰好相同** → 改为同分但置信度不同（alpha 0.5 / zeta 0.95），使分数序 `[zeta, alpha]` 与输入序 `[alpha, zeta]` 可分
- [x] 演练修正后的结果：**10/10**（见下条记录）
- [x] 计数守卫再次按设计生效：新增用例后 117 ≠ 文档 116，据此更新

## Phase 5 补充记录（演练工具固化，Round 48 续）

- [x] 把演练脚本固化为 `scripts/drill.mjs` + `pnpm run drill`：对 10 条承诺逐一注入对应回归、重建、跑所属测试，输出 `CAUGHT`/`MISSED` 与总计
- [x] 安全前提：脚本启动时检查 `git status --porcelain`，**工作树不干净即拒绝运行**（`exit 2`）——否则崩溃残留的变异无法与操作者自己的改动区分
- [x] 在两个全新 clone 上验证：修正后 **10/10 全部拦下**
- [x] README 命令清单与验证报告的承诺表同步（新增「每条承诺都有闸门拦得住回退」一行，结果 10/10）

## Phase 5 补充记录（演练工具自清理，Round 48 续 2）

- [x] 首次把 `pnpm run drill` 跑在全新 clone 上，发现它**没有还原完整**：每轮都会用变异后的源码重建 `lib/`，最后一次的产物留在树上（残留 `lib/tool-pruner.js(.map)`）
- [x] 修法：演练结束后**再构建一次**，并校验 `git status --porcelain` 为空；若非空则打印残留清单并以 `exit 1` 失败——「工具自己没还原干净」必须显式报错，而不是留给操作者发现
- [x] 实测（全新 clone）：`pnpm run drill` → 10/10 拦下、退出码 0、事后工作树干净

## Phase 5 补充记录（演练扩到集成层，Round 49）

- [x] 演练原本只覆盖单测层，而**本工作最严重的两个缺陷**（`agent/pre-step` 监听器吞掉决策 → 重启即崩溃；`result-shaper` 要求字符串而服务传块数组 → 模块在生产中失效）恰恰是单测看不见、只有真实运行时可抓的
- [x] 演练支持指定脚本（而非只有 spec），新增 2 条集成层注入：还原上述两个历史缺陷，指向 `tests/integration-dsh.mjs`
- [x] 自查纠正：第二条首次写成「删掉分支」，导致**类型错误**——被构建拦下而非被集成检查拦下，等于没验证集成层。改为「把 `apply()` 里的判定换回只认字符串」，**可编译但行为失效**，确认由集成脚本本体拦下
- [x] 可移植性：无 DSH 的机器上集成脚本按设计跳过，若不处理会被误报为 2 条 MISSED → 增加运行时探测，无 DSH 时标记 **SKIPPED** 并从总数中排除
- [x] 实测：有运行时 **12/12**（exit 0）；模拟无运行时 **10/10 + 2 SKIPPED**（exit 0）；两次跑完工作树均干净

## Phase 2 补充记录（剪枝默认值校准，Round 50）

整轮演练（全部模块 + 真实模型 + 真实装配）暴露出**发布默认值从未被测量**的问题，并抓到两个真实缺陷。

- [x] 发现缺口：bench、`verify:pruner`、单测**全都显式传 `minScoreThreshold: 1`** → 发布默认值 `2` 无任何测量覆盖
- [x] 测量阈值语义（12 工具、中英对照）：阈值 2 下多步意图只剩 1 个专用工具（调研类只留 `search_web`、修测试类只留 `run_tests`）；阈值 1 下保留完整工作集。**中英结果一致**，故判定为有意的激进取舍、不改默认值（`alwaysRetain` 的 shell 兜底仍可完成多数动作）
- [x] **缺陷 1（无目标仍剪枝）**：`assembly.sections` 无文本时 `userIntent` 为空，剪枝照做且结果随机——同一候选保留 `deploy_service` 却丢 `run_tests`，重复运行还不一致。修复：`minIntentChars`（默认 8），过短即跳过、不发请求。给定真实目标后 **3/3 次结果完全一致**
- [x] **缺陷 2（下限缺失）**：阈值 2 + 空保留表可把 12 个工具砍到 **0 个**，agent 无法行动。修复：`minKeep`（默认 3），从剩余候选按分数补齐
- [x] 新增 `tests/live-turn.ts` + `pnpm run verify:turn`：全模块 + 真实模型 + 真实装配的整轮演练；实测工具面 12 → 5、路由恰好 1 条建议、整形 32.7KB → 237 字符，单轮语义开销约 2.7–3.1s
- [x] 排查中修正自身两处错误：舞练一度传 `sections` 给 `assemble()`（该参数是**上下文**，section 须经 `ctx.systemPrompt.section({name,order,text})` 注册），导致两个模块都在对**空目标**排序；另修正了「阈值 2 一定错」的初判
- [x] 单测 +2（下限补齐、无目标跳过）；测试数 117 → 119；README 增两个配置项说明并纳入文档一致性断言

## Phase 5 补充记录（闸门是否真跑发布代码，Round 51）

延续第 50 轮的问题类别（「发布路径从未被真正执行」），系统审计 CI 闸门本身。

- [x] **发现结构性缺陷**：`bench/run.ts` 的 `loopVerdict` / `safetyVerdict` 把阈值**抄了一份**（0.3/0.6/0.5 与 0.85/1.7/0.5/0.7），而 bench 正是这两个模块的 CI 闸门 → 改发布阈值不会让闸门失败
- [x] 修复：抽出纯函数并由模块导出——`evaluateStuckTrajectory`（loop-guard）、`evaluateHazard`（safety-guard）——插件与 bench 共用；**离线数字完全不变**（36 条 / 34 正确 / 2 knownMiss / 误报 0）即为忠实抽取的证据
- [x] 顺带查清闸门分工：loop 阈值由 **bench** 拦下（改前不会）；安全阈值由**单测**拦下——原因是 bench 的四个语义用例全部经 `risk_score` 判定（2 / 1.2 / 1.48 / 1.37），危害概率均 ≈0，模型把危害与风险高度耦合。**这是分工而非缺口**：bench 覆盖模型真实走的路径，单测覆盖阈值区间
- [x] 演练修正两处自身问题：bench 会重写受跟踪的 `docs/calibration/bench-*.json` 使演练残留脏树 → 新增 `--no-artifacts`；安全阈值演练的归属改为覆盖它的那道闸门
- [x] 演练现状 **14/14**，跑完工作树干净；`docs/calibration.md` 新增 §13

## Phase 5 补充记录（近似实现的第二处，Round 52）

- [x] 沿用第 51 轮的审计线索全库搜索规则副本，发现 `tests/live-verify.ts` 同样**硬编码** `progress<0.3 && pLoop>=0.6 && confidence>=0.5`——而验证报告正是把该脚本列为「历史误报已修」的证据来源
- [x] 修复：改调 `evaluateStuckTrajectory` + 发布默认阈值；三场景仍全过且**测量值逐项一致**（0.72/0.70/0.10、pLoop 0/0/0.87、confidence 0.94/0.98/0.79）
- [x] 全库复扫确认无其他副本：`tests/`、`bench/` 中其余 `0.85`/`1.7` 字样均为测试夹具里的同数字（分数、版本号、置信度），非规则副本
- [x] 新增演练条目（改 `DEFAULT_P_LOOP_THRESHOLD` → `verify:live` 必须失败）并引入 `needsKey` 标记：无 Key 的机器记为 **SKIPPED**，避免把网络失败误算成拦下回归
- [x] 演练 **15/15**，工作树干净；`docs/calibration.md` §13.4 记录

## Phase 5 补充记录（覆盖率审计，Round 53）

用 Node 内置覆盖率把「闸门是否真跑发布路径」量化，而不是靠推理。

- [x] **缺口 1**：`index.js` 的 `connection.fetch.register` 路由处理器**从未被任何用例调用**——既有用例只测 webServer 形态与路径字符串，而 DSH 实际走 fetch 注册；其载荷、POST reset、`no-store` 头均无闸门。新增用例驱动该处理器并断言四项行为
- [x] **缺口 2**：客户端真实 `fetch` 与缓存**从未执行**（其余用例全走 `mockHandler` 短路）。新增 fetch stub 用例覆盖：序列化、同载荷不重复往返、TTL 过期重取、返回副本不污染缓存、非 2xx 错误文案
- [x] 覆盖率（`lib/*.js` 口径）：整体 **91.33% → 93.89% 行**；`index.js` **68.91% → 81.65%**；`typesafe-client.js` **79.78% → 92.78%**；测试数 119 → 123
- [x] 顺带清理死代码：按「导出符号是否被任何闸门引用」扫描 17 处候选，逐一定性后仅 `topBucketIndex` 为真死代码（src 内 0 使用、无引用、README 未提及）→ 删除；其余为常量/内部辅助，其中 `measureRemovedTools` 的**回退分支**本轮补了用例
- [x] 记录剩余未覆盖部分的归属（插件接线由 `verify:dsh` 覆盖），并写入 `docs/calibration.md` §14；README 增补覆盖率命令

## Phase 5 补充记录（钩子形状与规则 ask 模式，Round 54）

- [x] 从宿主源码确认唯一形状：`post-execute` = `(exec, result, next)`、`pre-execute` = `(exec, next)`；据此删除三个模块里 6–15 行**从未执行**的参数嗅探分支
- [x] 删除理由（**经演练修正**）：`pre-execute` 真实调用仅 2 参，旧守卫 `length >= 3` 永不为真 → 该容错是**不可达**而非错误，无回归可注入，演练条目已撤（无法触发的闸门会让人误以为有覆盖）；`post-execute` 的误判还需结果对象带 `name`。仍成立的两点收益：删掉不可达分支、形状变化会响亮失败
- [x] 自证：`safety-guard.spec.ts` 的 harness 原按不可达的三参形状调用，改为真实形状后 **7 个既有用例立即失败**并暴露了「测试在验证没有运行时使用的形状」，修复后全绿
- [x] 补上真实功能缺口：`SafetyGuard` 用户规则的 **ask 模式**（默认动作）从未执行 → 新增用例覆盖「命中可询问 → ask、headless → deny、低于阈值 → 不介入」
- [x] 覆盖率：`safety-guard` 94.82→**98.04%**、`loop-guard` 93.08→**95.68%**、`result-shaper` 95.03→**97.54%**、整体 93.89→**94.91%**（部分来自删除不可达分支）
- [x] 契约改由单测固定：传入带 `kind`/`action` 的执行对象，监听器仍须当作执行并照常检查
- [x] 测试数 123 → 125（规则 ask 模式 1 项 + 契约固定 1 项）；`docs/calibration.md` 新增 §15

## Phase 5 补充记录（宿主论断变闸门，Round 55）

- [x] 动因：第 15 轮证明「文档里的宿主论断写错也无人发现」。README 分工表里还有若干同类论断，其中 `deferExactRepeats: true` 是**功能依赖**——它把精确重复让位给 `dsh-repeat-tool-reminder`，该包若改名/改阈值，本插件就建立在不存在的假设上
- [x] 新增 `tests/dsh-contract.spec.ts`（4 项，无 DSH 时整体跳过）：① 三个内置包确实已安装；② 重复提醒仍以 `[3,5,8]` 为阈值默认；③ 已安装 DSH 满足 `engines.dsh`（含预发布语义比较）；④ 钩子实参形态（读宿主调用点 + 真实服务下行为验证 post-execute 恰收 `(exec,result,next)`）
- [x] 边界诚实标注：文本部分会因宿主重排而失败，**失败时应重新核对签名而非放宽断言**（写进断言消息）；引文类论断（内置包 Dev Note 原文）仍无法机器校验，保留但不假装已覆盖
- [x] 无 DSH 时 4 项全部跳过（实测 `pass 0 / skipped 4`），CI 跳过路径不变
- [x] 新增演练条目：`engines.dsh` 抬到 `>=99.0.0` → 该闸门必须失败
- [x] 测试数 125 → 129；`docs/calibration.md` 新增 §16

## Phase 5 补充记录（覆盖率续：动态挂载与容忍分支，Round 56）

- [x] `index.js` 的 **`ctx.inject` 动态挂载**从未执行（函数覆盖仅 52.94%）：DSH 服务晚加载时正走这条路。新增用例断言三个可选服务都被 await、无其它服务被注入、每个 fiber 都随插件 dispose（防止重载叠加注册）
- [x] `ask-tools` 三个原语各自的**注册失败容忍**（三个独立 try/catch）从未进入 → 让 `register` 对 `jev_rank` 抛错，断言其余原语照常注册
- [x] 客户端**缓存上限**（>200 淘汰最旧）从未执行 → 205 个不同载荷，断言最旧的被淘汰后重新往返、最近的仍命中
- [x] 覆盖率：`index.js` 81.65→**89.51%**（函数 52.94→**88.24%**）、`typesafe-client` 92.78→**94.22%**、`ask-tools` 97.74→**98.50%**、整体 94.91→**95.91%**；测试数 129 → 132
- [x] 核实并闭环一条旧线索：剪枝的**发布默认配置**已由 `verify:turn` 覆盖（只覆盖 `maxTools`，`minScoreThreshold` 与 `alwaysRetain` 取发布默认），第 50 轮的一次性测量无需再补
- [x] 在 `docs/calibration.md` §16.4 留档剩余未覆盖部分的**性质**（不可达输入、防御分支、或由 `verify:dsh` 覆盖的接线），避免后人重复审计

## Phase 5 补充记录（重启后验收脚本，Round 57）

- [x] 新增 `scripts/verify-host.mjs` + `pnpm run verify:host`：把「重启后应该好了」变成 6 条可判定检查——各 profile 携带当前构建、发行版与安装版一致、**运行中的宿主在执行本构建**、**实机指标为 v2 schema**、载荷含全部 v2 段、实机数字晚于它所测量的构建；每条失败附具体补救动作
- [x] 重启前实测：4 项通过、**3 项精确失败**（`restart still required` / `live file reports v1` / 缺 `resultShaper`），退出码 1——文件已就绪、进程未重载，正是应有的结果
- [x] 判定逻辑抽为纯函数 `buildAcceptance`，新增 `tests/verify-host.spec.ts`（5 项合成报告用例）：v2 宿主全通过、v1 宿主恰好三项失败、profile 漂移、版本不一致、载荷缺失 → 该脚本不依赖操作者机器状态也能被回归保护
- [x] 结构问题当场暴露并修掉：首次写成时测试导入该模块即执行 CLI（含 `process.exit`），改为「仅直接运行时执行」守卫
- [x] README 增补命令；验证报告的「待人工动作」改为「重启 → `pnpm run verify:host`（期望 exit 0）→ `pnpm run doctor`」
- [x] 测试数 132 → 137；`docs/calibration.md` 新增 §17

## Phase 5 补充记录（调研留档与引用守卫，Round 58）

- [x] 发现证据链断裂：计划首行把「调研结论」列为其两大依据之一，但仓库里**没有这份调研**（`docs/` 下只有 plan / calibration / verification-report）。评审者无法核对「借鉴了什么」
- [x] 新增 `docs/research.md`：**借鉴项 → 设计决策 → 落地模块 → 本仓库证据**的对照表（7 条，每条都指向可运行的闸门或标定小节）；另分列「本仓库自己测出来的（非借鉴）」与「主动**未**采纳的实践」及原因
- [x] **诚实标注范围**：本会话环境无联网检索工具，且当时的原始外部来源未留档 → 文档**不伪造引用**，明确写出「外部扫描部分未留档及原因」，并说明补齐方式（重跑检索补链接，而不是从现有文字反推）
- [x] 计划首行与 README、验证报告的文档索引均改为指向该文件
- [x] 新增守卫 `docs-consistency.spec.ts`：断言 `research.md` 引用的每个 `§N` 在 calibration 中有对应标题、每个 `path` 真实存在；**两半都做了牙齿验证**（`§99.4` → 报「no such heading」；`tests/nonexistent.spec.ts` → 报「does not exist」）
- [x] 新增演练条目使该验证永久化；测试数 137 → 138

## Phase 5 补充记录（部署链的整行替换语义，Round 59）

- [x] 追问部署链上**唯一未被验证的一环**：`cordis.patch.yml` 是否真会被宿主应用。查得宿主补丁分层为「bundle 层（`dsh.profile.bundles` 顺序）→ profile 自身的 `cordis.patch.yml` → `--patch` 覆盖」；`dsh --profile desktop --dump-config` 被拒（desktop 由 Electron 独占，与 Round 12 记录一致）
- [x] 改用**对照宿主自带补丁文件**验证形状：`- insert:` + 行键 `{id, name, disabled, inject, config}` 与我们的文件一致；新增断言「我们只使用宿主自己也在用的操作与行键」
- [x] **发现用户会踩的坑**（来自 `dsh-base/cordis.patch.yml` 原文）：*"A patch replaces the targeted row's whole `config` rather than merging into it … the last write winning per row."* —— 即补丁是**整行替换**，用户若只写要改的那个键，会连带丢掉该行其余配置（如 `guardedTools`、`alwaysRetain`、`client.apiKey`）。README「方式 2」此前**没有这个警告**，已补上并引用宿主原文
- [x] 按 §16 的做法把该语义也变成闸门：断言宿主文件仍声明同一语义（跨行注释先归一化再匹配）且 README 保留该警告 —— 若 DSH 将来改为深度合并，警告会失效并由该断言暴露
- [x] 测试数 138 → 140（`dsh-contract` 6 项，无 DSH 时跳过）

## Phase 5 补充记录（随包补丁数值漂移守卫，Round 60）

- [x] 发现同类缺口：`packaging.spec.ts` 只断言补丁的**键合法**与两个列表 ⊇ 库默认，**没有任何闸门**比较补丁里钉住的**数值**与代码默认值。由于补丁整行替换（§Round 59），这些数值正是每个用户实际运行的值——代码改默认而补丁留旧值，部署行为会与文档默认**静默背离**（README 有 docs-consistency 守卫，补丁没有）
- [x] 新增守卫「补丁钉住的每个标量都必须等于代码默认，且必须在本测试**登记**」：未登记的新键会失败（提示「register it here」），因此将来新增钉住项无法绕过
- [x] 新增守卫「随包补丁不得开启实验性 shaper」：`resultShaper` 与 `askTools` 均不得出现在补丁里（前者是 opt-in 契约，后者应依赖代码默认）
- [x] 首次运行时发现我的断言写错了（要求补丁必须钉住 `minKeep`/`minIntentChars`）——补丁省略即回退代码默认，行为正确；改为「登记的键必须匹配」后通过
- [x] **牙齿验证**：把补丁的 `pLoopThreshold` 改成 0.95 → 报 `cordis.patch.yml pins pLoopThreshold away from the code default`；已加演练条目永久化
- [x] 测试数 140 → 142

## Phase 5 补充记录（配置项文档完整性守卫，Round 61）

- [x] 检查下一层一致性：现有守卫是「补丁的键在类型里」（patch → types），**反向没有**——类型里被代码接受的字段是否都在 README 中有说明，无人守卫
- [x] 实测 7 个 `*Config` 接口共 **50 个字段中有 5 个未在 README 出现**。其中 **`SafetyGuardConfig.headless` 是真实遗漏**：它决定「无法弹窗时 ask 是否转为 deny」，属安全相关行为却无文档；其余 4 个（`client` / `loopGuard` / `safetyGuard` / `toolPruner`）是**套件配置的嵌套写法**没展示，读者无法从配置参考里看出如何组装
- [x] 补齐：README 的套件小节列出各模块字段与类型（并提示「未出现的模块取代码默认」），SafetyGuardConfig 小节补上 `headless` 的语义与默认值
- [x] 新增守卫「**代码接受的每个配置字段都必须在 README 中有说明**」：直接读 `src/types.ts` 的接口而非维护一份清单，因此将来新增字段无法绕过
- [x] **牙齿验证**：删掉 `headless` 那行 → 报 `these config fields are accepted by the code but absent from README`；已加演练条目永久化
- [x] 测试数 142 → 143

## Phase 5 补充记录（变更日志完整性，Round 62）

- [x] 审计「变更日志是否覆盖 README 迁移表里的破坏性变更」：初版用字面标记（`version: 2`、`不迁移`）判定为缺失，实际是**我的标记过于字面**——CHANGELOG 用的是「指标文件 schema 升至 v2」等表述，三处破坏性变更**都在**
- [x] 但审计撞见**真实缺陷**：`Changed` 小节里有**两组条目逐字重复**（46-51 与 52-57 行完全相同，疑似合并时粘贴两次），会让一处变更看起来像两处
- [x] 修复重复条目；新增两道守卫：① 同一发布小节内**不得出现重复条目**；② README 迁移表点名的三处破坏性变更必须**在 CHANGELOG 里有对应公告**（用概念标记而非措辞，故措辞变化不会误报）
- [x] **牙齿验证**：复制一条条目 → 报 `the changelog repeats these bullets`；已加演练条目永久化
- [x] 顺带核实：`package.json` 的 17 处脚本文件引用**全部存在**（无缺口，未加守卫——避免为不存在的风险增加维护面）
- [x] 测试数 143 → 145

## Phase 5 补充记录（构建产物漂移守卫，Round 63）

- [x] 发现缺口：`lib/` 入库且**单测导入的正是 `lib/`**，但 CI 只做「构建 → 测试」，**从不比较重建后的 `lib/` 与已提交的 `lib/`**。因此「改了 `src` 忘记重建并一起提交」会让单测在**旧构建**上全绿，而仓库发布的是旧代码——CI 的重建恰好把这个漂移隐藏掉
- [x] 新增 `scripts/verify-build.mjs` + `pnpm run verify:build`：构建后断言 `git status --porcelain -- lib` 为空，非空则列出漂移文件并给出补救命令（`pnpm run build && git add lib && git commit`）；非 git 检出时明确 SKIP
- [x] CI 在 Build 之后立刻插入该步骤（步骤序：Install → Build → **构建产物一致** → typecheck → test → bench → verify:dsh → 打包校验）
- [x] 实测两个方向：干净状态 `ok`／exit 0；只改 `lib/` 造成漂移 → 列出 `M lib/tool-pruner.js`／exit 1
- [x] 新增演练条目：把 `src` 的 `DEFAULT_MIN_KEEP` 改成 99（重建后与已提交产物不一致）→ `verify-build` 必须失败
- [x] README 验证命令清单补入 `pnpm run build && pnpm run verify:build`

## Phase 1 补充记录（确定性拒止语料库，Round 64）

- [x] 换方向：不再审计一致性，而是用 **41 条真实命令语料**检验确定性拒止规则（纯离线、不执行命令），逐条声明「必须硬拒」或「必须放行」——首次运行即抓到 **6 处漏判**
- [x] **缺陷 A**：`rm -rf /etc`、`/usr`、`/var`、`/home/user` 此前全部放行（`rootish` 只认 `/`、`~`、`X:\`）。按「只拦无正当用途的形态」扩展为**顶级系统目录 + 整个家目录**；**二级及更深路径刻意不拦**（`/var/lib`、`/etc/nginx`、`/home/user/project` 是有正当用途的工作路径），边界写入语料库
- [x] **缺陷 B（安全相关）**：凭据外传规则的第二条分支 `\.ssh\/id_\b` **永不匹配** `id_rsa`（`_` 与 `r` 均属 `\w`，无词边界）→ `cat ~/.ssh/id_rsa | curl …` 这类读取私钥并管道外传的典型形态不进硬拒。既有单测恰好只覆盖 `-F file=@` 上传形态，因此长期为绿
- [x] 顺带堵住绕过：`bash -c "rm -rf /"` 此前不拦（分词后动词为 `"rm`）→ 分词统一去引号；新增单测断言裸写与包装写法命中**同一条规则**
- [x] 语料库含明确写出的取舍边界；基准 36 条与全部单测在修复后**不变**（误报仍 0）
- [x] 测试数 145 → 148；`docs/calibration.md` 新增 §18

## Phase 1 补充记录（凭据与格式化形态，Round 65）

- [x] 第二遍探测 25 条真实形态，再抓 **5 类漏判**：真实凭据文件（`.npmrc`/`.netrc`/`.kube/config`/`.docker/config.json`/`.pgpass`）、Windows 路径分隔符（`\.aws\credentials` 因规则只写 `/` 而漏）、`mke2fs`、perl 与带空格的 fork bomb、`/Applications` 与 `C:\Users` 两个顶级目录
- [x] **同时检查误报面并据此收紧两处**：`mke2fs disk.img`（嵌入式镜像）是正当用法 → 仅当目标是 `/dev/…` 才硬拒；`.env.example`/`.env.sample` 是分享用模板却被误拒（属既有缺陷）→ 加负向断言，模板放行而 `.env`/`.env.local` 仍拒
- [x] **自我纠正**：我一度臆测加入「`while true; do … & done`」为 fork bomb 形态，复查判定无证据且可能命中正当后台循环 → 删除（延续第 54 轮原则）
- [x] 语料库扩到 **69 条**（47 硬拒 / 22 放行）；全部单测与 36 条基准不变，**误报仍 0**

## Phase 1 补充记录（外壳的检视面，Round 66）

- [x] 第三遍探测固定命令、改**参数形状**，刻画 `inspectableText` 的检视面，两个方向各抓一处：
- [x] **漏判**：命令嵌在 `{options:{command}}`、`{nested:{deeper:{script}}}`、`{steps:[{command}]}` 里时全部逃逸（只读顶层字符串）→ 改为**递归收集命令键下的字符串值**（深度上限 6，键集 `command`/`cmd`/`script`/`code`/`shell`/`exec`/`entrypoint`）
- [x] **误报（本轮最重要的发现）**：外壳把 `content` 也当命令匹配，于是 `write_to_file {path, content}` 只要正文含 `rm -rf /` 就被硬拒——**「编写危险命令文档」这一常见正当工作会被阻断**；而 `content` 对受保护的文件工具是数据而非被执行物。移除数据键检视（`content`/`body`/`text`/`input`/`url`/`path`）
- [x] 边界写进语料库：`{content:'rm -rf /'}`、`{edits:[{newText:'rm -rf /'}]}`、非命令键下的裸字符串数组**必须放行**
- [x] 语料库 69 → **76 条**（50 硬拒 / 26 放行）；单测 148、基准 36 条（误报 0）、集成 22 项**均不变**

## Phase 1 补充记录（动词与开关同义写法，Round 67）

- [x] 第四遍探测固定语义、换**拼写**，抓 4 类漏判：**`erase`（cmd 的 `del` 官方别名）**、**`ri`（PowerShell 的 `Remove-Item` 官方别名）**、**`rm -rf /{etc,usr}` 花括号展开**、**`find / -delete` / `find ~ -delete`**（从根/家目录递归删除）
- [x] 修复：动词表加入 `erase`/`ri`；匹配前做**语法级花括号展开**（深度上限 4）；新增 `find <根|~|$HOME> … -delete` 与 `-exec` 形态规则
- [x] 自查纠正：`find / -delete` 首次修复后仍漏——正则里 `(?:\s|$)` 已消费空格、后面又要求一个空格；属实现疏漏，已修并复测
- [x] **明确划出不属于硬拒的形态并写进语料库**：`shred`/`truncate`/`chmod` 对工作区内单个目标、`rm -rf .`、`git rm`、以及「动词只出现在文本里」——避免后续顺手扩大扫描面
- [x] 语料库 76 → **92 条**（58 硬拒 / 34 放行，按数组实际计数）；单测 148、基准 36 条（误报 0）不变

## Phase 4 补充记录（前置检查语料库，Round 68）

- [x] 换纯函数表面：为整形器前置检查 `looksRepetitive` 建 16 例语料库（构建日志、依赖树、目录列表、git log、时间戳日志、短结果、散文、空输出等），判错两个方向都有代价（白花请求 / 功能失效）
- [x] **本轮未发现缺陷**：16 例全部符合预期。但两处「与我预期不符」值得留档——60 行编号报告与 40 行栈帧**只差数字**，结构归一后同形，触发是设计意图（分类器随后决定去留；早前实测确认栈帧被判 `failure` 而保留，故触发无害）。**修正的是我的预期，不是代码**
- [x] 固化为 `tests/repetition-corpus.spec.ts`：16 例各带「为何如此判定」的说明，并附耗时断言确保该检查保持纯字符串操作
- [x] 测试数 148 → 150；`docs/calibration.md` §18.8

## Phase 1 补充记录（精确重复让位边界，Round 69）

- [x] 探测最后一个有真实逻辑的判定面：`deferExactRepeats` 的**让位范围**（过宽则真循环沉默）
- [x] 7 条边界全部符合预期：连续同工具同参数同输出→让位；输出不同／参数不同／工具不同／仅空白不同→交语义层；显式关闭→判定；**参数键序不同→仍视为同一次重复**（规范化生效）
- [x] **未发现缺陷**（连续第二个空结果）。首次 7 条全不触发是**我的探针 harness 写错**：`resolveClientFrom` 要求真正的 `TypeSafeClient` 实例，我传了普通对象 → 回退无 key 客户端 → 抛错被吞。修正后 7/7
- [x] 固化为单测（含键序规范化这条真实属性），防止后续把让位范围改宽
- [x] **覆盖审计收束**：确定性外壳（92 例）、整形前置检查（16 例）、重复让位（7 例）均有语料覆盖；剩余风险只在**未重启的宿主进程**，判据为 `pnpm run verify:host`
- [x] 测试数 150 → 151

## 收尾核验（Round 70）

目标（完成本计划全部条目）已达成的最终证据，全部为可复现命令的输出。

- [x] **计划条目**：本计划实施部分全部勾选；仅余 1 项**未勾选**，即下一条列出的人工动作（重启宿主）——留在清单里是为了让该遗留项在交付物中可见，而不是把它划掉
- [x] **卫生排查**（`src/` 13 个文件）：**0 处** `console.log` / `TODO` / `FIXME` / `debugger` / 调试开关 / 聚焦测试 / 未实现占位；6 处 `console.warn` 全部位于「失败即保持原行为」的路径（每模块一处 + tool-pruner 的 waterfall 包装一处），意图明确
- [x] **纯判定表面的语料覆盖**（覆盖审计收束）：确定性拒止外壳 92 例、整形前置检查 16 例、精确重复让位 7 例
- [x] **全新 clone 端到端复现**（当前提交）：`install --frozen-lockfile` → `build` → `verify:build` ok → `typecheck:scripts` → 单测 **145 通过 + 6 跳过**（clone 内无 DSH，`dsh-contract` 的 6 项按设计跳过，故 151−6=145，**同时印证了跳过路径**）→ `bench:offline` → `verify:dsh` 正确 SKIP → **重建后 `lib/` 零漂移**
- [x] **宿主之外的各层判据**：151 单测 · 22 项集成校验 · 5 个线上脚本 · 36 条基准（误报 0）· 21 条注入回归全部拦下 · 构建产物一致
- [ ] **待人工动作**：重启 DSH 桌面端，然后 `pnpm run verify:host`（期望 exit 0、7 项全 `ok`）与 `pnpm run doctor`（期望 `OK`）。这是本项目**唯一无法由本会话完成**的事项：重启会终止当前进程，且宿主进程保留启动时加载的构建

## 收尾核验（证据索引同步，Round 71）

- [x] 发现**证据索引过期**（第 42 轮刷新后，第 46–70 轮新增的闸门未进索引）：`verify:build` 与 `verify:turn` 未在复现清单；drill 计数仍写 **15/15**（实际 21/21）；基准仍写 **30 条**（实际 36）；**两个语料库完全未被提及**——而它们正是纯判定表面最强的证据；承诺表也缺 Round 47–67 新增的闸门（补丁数值一致、配置项文档完整、变更日志公告、宿主契约、构建产物一致等）
- [x] 刷新三处：状态表增 4 行（线上模块验证补 `verify:turn`、守卫网自检、构建产物一致、宿主验收）；承诺表增 8 行（三个语料库 + 补丁一致 + 配置文档 + 变更日志 + 宿主契约 + 构建产物）；复现清单补齐至 16 条命令
- [x] 新增守卫「**证据索引必须点名每个闸门**」：`package.json` 中每个 `verify:*`（及 `test`/`drill`/`bench:offline`/`typecheck:scripts`）、每个 `*corpus*.spec.ts`、每个 `scripts/*.mjs` 都必须在报告中出现；命令名映射处理 `verify-build.mjs` → `verify:build`
- [x] 新增演练条目：从复现清单删掉 `pnpm run drill` → 该守卫必须失败
- [x] 测试数 151 → 152

## 收尾核验（摘要数字同步，Round 72）

- [x] 审计 README 与计划「交付摘要」里的数字：**摘要的逐模块计数已过期**——`loop-guard` 写 10（实为 13）、`safety-guard` 写 9（实为 11）、`tool-pruner` 写 5（实为 8）、`ask-tools` 写 6（实为 7）、两处基准写 30 条（实为 36）。总数一直有守卫，**逐模块的拆分没有**
- [x] 修正五行，并在其中补记新证据（safety-guard 增加「92 例命令语料」、result-shaper 增加「16 例前置检查语料」）
- [x] 新增守卫「**交付摘要的逐模块计数必须与用例文件一致**」：显式登记 模块→spec 映射（`typesafe-client` 含 `client.spec.ts` + `resilience.spec.ts`，因失败行为在后者中断言），并把「期望值」也写进用例——改了 spec 就要同时改这两处，无法单边漂移
- [x] **牙齿验证**：把摘要改成「单测 10 项」→ 报 `the summary claims a test count for loop-guard that the specs no longer hold`；已加演练条目
- [x] 测试数 152 → 153

## 收尾核验（计数声明收敛，Round 73）

- [x] 把同类审计做成一次收敛：扫描全部文档的**数字声明**，找出仍未被守卫覆盖的可核对项 → drill 注入数（报告写 21，实际 **23**）与两个语料库例数（92 / 16）均只有「被点名」的守卫，**没有「数字正确」的守卫**
- [x] 修正报告的 drill 计数（21 → 23）；历史附录中的旧数字保留（它们是当时的快照）
- [x] 新增守卫「**报告的 drill 规模与语料库例数必须与文件一致**」：drill 条目数从 `scripts/drill.mjs` 的 `drills` 数组读出，语料例数按 CASES 条目缩进计数（一个语料用字符串 `expect`、另一个用布尔 `expect`，不能靠值匹配）
- [x] 自查纠正：守卫首版把语料例数计成 0（正则只匹配字符串 `expect`，而前置检查语料是布尔）→ 改为按条目缩进计数，实测 92 / 16
- [x] **牙齿验证**：把报告里的 drill 计数改回 21 → 该守卫失败；已加演练条目
- [x] 测试数 153 → 154

## Phase 5 补充记录（发布物内容，Round 74）

- [x] 转向**非自我指涉**的检查：打包后的 tarball 里到底有什么。此前 CI 只断言 9 个 lib 模块在内、打包用例只断言**仓库里**存在补丁文件——而宿主加载的三样东西里，`cordis.patch.yml`（`dsh.bundle.patch` 的指向）若被 `files` 字段漏掉，**所有用户的 Bundle 挂载都会失败**，且没有任何闸门会发现
- [x] 实测 tarball：57 项、52 个 `lib/*`、含 `package.json`/`lib/index.js`/`cordis.patch.yml`/README/CHANGELOG、**无** `tests|tmp|bench|scripts|src|.github` 噪声——当前正确
- [x] 提升为单测（本地与 CI 同一处）：断言宿主需要的每一项都在包内、**每个构建产物模块都在包内**（新增模块无法被遗忘）、且不含任何开发文件
- [x] 撤掉 CI 中重复且较弱的 `Packed contents include every built module` 步骤（单测在 CI 的 Unit tests 步骤里已跑，且检查更多）；CI 现有 7 个 run 步骤
- [x] 两处自查修正：Windows 上 `npm` 是 `npm.cmd`，`execFileSync` 需 `shell: true`；替换注释时 `\n` 陷阱导致调用被并入注释行
- [x] 测试数 154 → 155

## Phase 5 补充记录（发布物可安装性，Round 75）

- [x] 把发布物检查推进到最后一环：**打包 → 装进干净目录 → 按包名导入**。单测导入的是工作区里的 `lib/`，因此「装不上」或「`main`/`types`/`exports` 指向不当」对用户才暴露，此前无任何闸门
- [x] 新增 `scripts/verify-pack.mjs` + `pnpm run verify:pack`，断言五项：产出 tarball；入口导出宿主挂载所需的 **8 个符号**；**5 个服务类**同样在包内；安装后的清单三个目标（`main`/`types`/`dsh.bundle.patch`）均可解析；补丁文件可读且确实挂载 `dsh-jev`
- [x] 实测通过：tarball 57 项、安装后按名解析成功、入口 8 个导出齐全
- [x] 纳入 CI 作为独立步骤（CI 现有 8 个 run 步骤）与 README／证据索引（索引守卫要求 `verify:*` 必须出现在复现块内，加入后立即通过）
- [x] 新增演练条目：把 `main` 指向不存在的文件 → `verify:pack` 必须失败
- [x] 自查修正：脚本首版用 `readdirSync` 判断**文件**存在（`ENOTDIR` → 一律判缺失），改用 `existsSync`

## 审计收敛（Round 76，结论：不再新增审计）

第 64–76 轮以「找尚未被守卫的表面」为线索推进，结果是一条清晰的收敛曲线：

| 轮次 | 对象 | 结果 |
|---|---|---|
| 64–67 | 确定性拒止外壳：命令形态 → 凭据/格式化 → 参数形状 → 动词拼写 | **12 处真实缺陷**（含两条安全相关：死分支 `\.ssh\/id_\b`、系统目录未拦） |
| 68–69 | 整形前置检查、精确重复让位 | **空结果**（两处「与预期不符」经复核是**我的预期错**，代码正确） |
| 70–75 | 卫生排查、端到端复现、证据索引、摘要计数、tarball 内容与可安装性 | 索引与计数**确有漂移**（已修并加守卫）；tarball **无缺陷**（覆盖率提升） |
| 76 | 设置面板 vs 配置面 | **空结果**：面板是状态看板而非配置参考（我的前提错两次）；其可见性不变量早已按**正确粒度**设闸门（面板读取的路径都在快照里、每个快照段都有卡片、Markdown 覆盖每段） |

**因此不再提议新的审计**：连续三次空结果（68、69、76）表明已到达该方法的产出边界。当前已验证的表面清单：

- 语料：拒止外壳 92 例 · 前置检查 16 例 · 重复让位 7 条边界
- 闸门：155 单测 · 22 项集成 · 5 个线上脚本 · 25 条注入回归 · 36 条基准（误报 0）· 构建产物一致 · 发布物可安装
- 文档一致性：默认值、计数、引用、配置项覆盖、变更日志公告、补丁数值、索引完整性

**剩余风险只有一处，且不在代码**：宿主进程未重启，其判据为 `pnpm run verify:host`（期望 7/7、exit 0）。

## 采用性补充（README 实测摘录，Round 77）

- [x] 面向采用补一节「**实际效果**」：README 此前只有能力表与配置参考，缺「它工作起来是什么样」。新增四组**逐字摘录**并各自标注来源命令——死循环判定（健康 0.67/0.00 不触发 vs 真循环 0.10/0.88 命中）、工具剪枝（「提交并推送」保留 `git_commit,git_push,run_tests`）、结果整形（32.7KB → 253 字符、纯噪声拒绝）、整轮语义开销（12 工具 → 5、路由 1 条建议、3.7s）
- [x] 全部数字为**当时命令的真实输出**（非编写），并注明「数值随请求与输出规模变化」+ 指向 `docs/calibration.md` 的完整标定；未对这些易变数字设闸门（它们本就不是不变量），而是给出可复现命令

## 收尾核验（CI 步骤全量演练，Round 78）

- [x] 此前只在第 70 轮演练过一次流水线，而**第 75 轮新增的 `verify:pack` 从未在干净环境跑过**。本轮按 CI 的 **8 个步骤原样演练**（全新 clone、`DSH_HOME` 指向不存在路径）：Install 0 → Build 0 → `verify:build` ok → `typecheck:scripts` 0 → 单测 **155 = 149 通过 + 6 跳过** → `bench:offline` 0 → `verify:pack` installs and resolves → `verify:dsh` 正确 SKIP → **`lib/` 零漂移**
- [x] **发现并修掉一处 CI 脆弱点**：包无运行时依赖但有 **peer 依赖** `@deepseek-ai/cordis`，而 npm 7+ 会尝试自动解析 peer——这会让一个「验证发布物」的步骤依赖 registry 可达性。给 `verify:pack` 的安装加 `--omit=peer`（入口运行时不导入任何依赖，故自洽），实测仍 5/5 通过
- [x] 验证报告「干净 clone 复现」一行改为如实列出 8 个步骤与其结果

## 工作协议自查（Round 79）

任务约定是「每当实现一个 phase，**记得 plan md 打钩，代码 + md 提交一次**」。对第 1 条提交至今的 107 个提交做了逐条核对：

| 维度 | 结果 |
|---|---|
| 触及 `src/`/`tests/`/`scripts/`/`bench/` 或 `lib/` 的提交 | **78** |
| 其中**同一提交**内同时更新计划文件 | **66** |
| 只带代码、计划记录落在**下一个**提交 | **12** |
| 这 12 个在 HEAD 的计划文件里**有无对应记录** | **12/12 有**（`without any plan mention: 0`） |

**结论**：约定的**实质**成立——每一次代码改动都在计划文件里有记录，且 HEAD 上实施项无遗留；偏差只在**提交粒度**：12 个加固/审计轮次（多为 `test(bench…)`/`test(drill…)`/`fix(bench…)`）是「先提交代码、再把该轮结论合并成一条计划附录」，因此计划文件晚一个提交落地。

原 Phase 0–5 的实现提交均为**代码 + 计划同提交**（66 条中的主体），协议对「phase」这一级是照做的。

**不重写历史**：内容正确，重写 12 个提交只会带来风险而无收益；此表即为如实记录。

## Phase 5 补充记录（部署声明漂移，Round 84）

- [x] 检查「重启能否生效」时发现**操作性风险**：profile 清单用精确版本声明插件（`dsh-jev: 0.1.0`），而 `sync` 是原地替换安装副本（实际 **0.2.0**）→ 该 profile 里**任何一次 `pnpm install`**（任何 `dsh plugin add` 都会跑）都会把同步进去的 0.2.0 **静默换回 0.1.0**
- [x] 同时确认挂载无误：`dsh.profile.bundles` 含 `dsh-jev`，故重启会加载它（只是加载的代码与声明不一致）
- [x] 修复 1：`sync-profiles.js` 同步后**对齐声明版本**——只改该依赖、其他不动；已一致/无清单/未声明时**不写入**；`--dry-run` 不写。实测本机 profile 由 `0.1.0` 对齐为 `0.2.0`，其余依赖保持原值
- [x] 修复 2：`doctor` 新增 `declaredVersion` 与 `verdict.declaredMatch`，报告以 `(manifest declares 0.1.0)` 点出漂移
- [x] 自查修正：首版路径少了一层（`<profile>/node_modules/dsh-jev` 的清单在上两级），对齐未生效；修正后实测生效
- [x] 测试数 155 → 160（sync +4、doctor +1）；README 增补该行为的说明；`docs/calibration.md` §19

## Phase 5 补充记录（重启就绪性最后一环，Round 85）

- [x] 沿上一轮的部署线索继续追问：**重启后插件会不会因拿不到 API Key 而静默什么都不做？** 补丁里写的是 `client.apiKey: !!js process.env.TYPESAFE_API_KEY`，宿主若不导出该变量则为 `undefined`
- [x] 实测（决定性）：移除环境变量、并按「宿主无法求值该标签」传 `__jsExpr:…` 占位符后，客户端**仍自行读 `~/.dsh/.env` 取到密钥**（长度 107）→ 该环节无缺口
- [x] 顺带确认面板注入的 `@deepseek-ai/dsh-client-ui-settings` **在宿主中存在** ✓
- [x] 把该检查并入 `pnpm run verify:host`（现 **7 项**）：测试运行器下客户端**刻意拒绝**环境密钥，故此时标注为「不适用」而非失败（否则测的是隔离机制而非部署）
- [x] 新增计数守卫：验收项数在文档中出现三处，现从脚本读取比对；连带修正我自己两次计数错误（漏掉循环内一项、多减了辅助函数）
- [x] 修正一处**误报**：新鲜度检查（「实机数字晚于它所测量的构建」）在**重建后、重启前**必然失败——重启前运行中的宿主本就早于本次构建；现仅在其已运行当前构建时才断言，否则标注「重启前不适用」
- [x] 新增演练条目：移除客户端读密钥文件的回退 → `verify:host` 必须失败（演练 26/26）
- [x] 测试数 160 → 161
