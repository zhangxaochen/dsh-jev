# dsh-jev 优化计划（可勾选执行清单）

> 依据：本会话实测基线 + 社区实践调研（见各条「依据」）。
> 执行规则：每完成一个 Phase，勾选本文件，代码 + 本文件一起提交一次，再进入下一个 Phase。

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
