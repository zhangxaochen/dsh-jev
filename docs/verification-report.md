# 验证报告（dsh-jev 0.2.0）

本文件是**证据索引**：每条承诺对应一种验证手段与其结果，以及抓到缺陷时用的是哪一种手段。
标定数字与阈值来源见 [`calibration.md`](calibration.md)，逐项执行清单见 [`OPTIMIZATION_PLAN.md`](OPTIMIZATION_PLAN.md)。

## 状态一览（最近一次实测）

> 下列数字是**某一时刻的快照**；用例数与检查数会随版本增长，权威结果以命令输出为准
> （文档里写死数字正是此前发现过的一类缺陷）。本次快照由下方命令在同一工作区连续运行得出。

| 维度 | 结果 |
|---|---|
| 版本 | `0.2.0`（含破坏性配置变更，升级须知见 README） |
| 离线单测 | **132/132**（`pnpm test`；其中 4 项在无 DSH 时跳过） |
| 真实 DSH 集成 | **22/22**（`pnpm run verify:dsh`；无 DSH 时跳过并退出 0） |
| 线上模块验证 | `verify:live` 3/3 · `verify:tools` 3/3 · `verify:shaper` 4/4 · `verify:pruner` 6/6 · `verify:router` 6 PASS + **1 条已记录跨语言漏报** |
| A/B 基准 | 36 条样本（loop/safety/shaper/pruner/router）、准确率 **94.4%**、**误报 0**、2 条已记录漏报；离线回放带输入指纹校验（`pnpm run bench:offline` 零成本复现） |
| 干净 clone 复现 | `install --frozen-lockfile` → `build` → `test` → `bench`，且重建后 `lib/` 零漂移 |
| 布局状态 | `doctor` 报告 `ACTION: restart DSH`（文件已同步，宿主进程未重载） |

## 已验证的承诺

| 承诺 | 验证手段 | 结果 |
|---|---|---|
| 受保护工具上判定不可用时**失败关闭** | 单测（`resilience.spec.ts`）+ 集成 | 429/500/超时 → `deny`；`onError: 'allow'` 可退回旧行为 |
| 确定性外壳**先于**可扩展 waterfall 拒止 | 集成（真实 `dsh-tools`） | 拒绝时工具体执行 **0** 次，且后续「一律放行」监听器**从未被调用** |
| 死循环判定不再误报健康轨迹 | 线上回放（`verify:live`，**调用发布规则**）+ 36 条基准 | 两类历史误报形态 `progress` 0.72/0.70、`pLoop=0.00` 不触发；真循环 `pLoop=0.87` 命中 |
| 工具剪枝保持上游顺序 | 单测（3 项） | 入选集合不变时顺序等于输入序；`alwaysRetain` 不被提前 |
| 剪枝排序质量（真实模型） | 线上（`verify:pruner`，6 标注用例） | 必需工具**零遗漏**；不相关项被阈值滤掉而非凑数；253–700ms |
| 剪枝结果被真实装配接受 | 集成（真实 `dsh-system-prompt`） | 不抛不变量错误，工具面 4 → 2 |
| 结果整形只改模型可见内容 | 集成（真实服务 `postExecute`） | 1592 → 213 字符，保留信息块、插入丢弃标记，不违反不变量 |
| 结果整形的**行形状分类**有效 | 线上（`verify:shaper`，4 类真实输出） | 压缩 130×–190×；报错/告警/失败测试全部保留、噪声全部丢弃；纯噪声拒绝 |
| skill 路由消费真实目录 | 集成（真实注册表）+ 线上（`verify:router`） | 112 项目录，恰好一条建议；6/7 标注意图命中 |
| skill 路由的请求能在预算内完成 | 线上（`verify:router`） | 全目录请求 1.36–1.45s，路由自有 4000ms 预算（此前 800ms 必然超时） |
| 各模块共存互不淹没 | 集成（六个插件同挂一个 Context） | 剪枝、路由、整形、提示四者同时生效 |
| 提示经真实链路送达会话 | 集成 | `additionalContexts` 一条，`source.plugin` 正确 |
| 面板端点与宿主路由一致 | 单测（跨文件解析 + 构建产物） | 三处路径一致 |
| 逐项提问把项内容嵌在问题里 | 行为断言（`tests/question-binding.spec.ts`） | 四处提问两两不同且各含自身项文本 |
| 发布配置不弱化保护 | 单测（解析 `cordis.patch.yml`） | `guardedTools` ⊇ 库默认且含文件写入；`alwaysRetain` ⊇ 库默认 |
| 文档默认值不说谎 | 单测（从 README/calibration 反解数字比对代码常量） | 全部一致（曾抓到 1 处不符） |
| 验证脚本不写实机状态 | 单测（`tests/isolation.spec.ts`）+ 实测前后对比 | 连跑单测/集成/基准后，实机指标与决策日志均不变 |
| **每条承诺都有闸门拦得住回退** | 回归演练（`pnpm run drill`，15 条注入） | **15/15**：每条承诺的对应回退都能被某个闸门拦下，其中 2 条（崩溃级、模块失效）只有真实运行时能抓到，无 DSH 时标记为 SKIPPED |
| bench 跑的是发布规则而非其副本 | 回归演练（改 `DEFAULT_P_LOOP_THRESHOLD` / `DEFAULT_BLOCK_THRESHOLD` 必须失败）+ 抽取前后离线数字一致 | loop 阈值改为由 bench 拦下；安全阈值由单测拦下（bench 语义用例全走 `risk_score`） |

## 抓到的真实缺陷（按严重度）

| # | 缺陷 | 后果 | 谁抓到的 |
|---|---|---|---|
| 1 | `agent/pre-step` 监听器未调用 `next()` | waterfall 返回 `undefined`，agent loop 在 `decision.kind` 上抛错——**重启即崩溃** | 真实 cordis 集成校验（只驱动了裸 waterfall 的测试无法发现） |
| 2 | `result-shaper` 要求 `content` 为字符串，而真实服务传**块数组** | 该模块在真实管线里**从不生效**（单测却全绿） | 真实 `dsh-tools` 服务级校验 |
| 3 | 随包 `guardedTools` 漏掉文件写入工具 | 默认安装下 `write_to_file` / `replace_file_content` **无任何语义门禁** | 审「发布配置 vs 库默认」 |
| 4 | `loop-guard` 反向三元阈值（配置 2 实际生效 1.4） | 健康轨迹被判死循环（本会话实测两次误报） | 探针确认 `score` 真实刻度 + 线上回放 |
| 5 | `tool-pruner` 按相关性重排工具 | 请求前缀每轮变化，冲击 KV cache 复用 | 审设计承诺 D5/D6 的落地 |
| 6 | `normalizeAnswers` 把缺失答案强制成 0 | 「不知道」被当作「0% 危害 → 放行」 | 失败模式审计 |
| 7 | `deterministicVerdict` 对 `rm -rf /`、`rm -rf ~` 失效 | 硬拒集在常见形态上形同虚设 | 单测（参数经 JSON 序列化后结尾是引号，`$` 锚点失配） |
| 8 | `resolveApiKey` 在测试中回退读 `~/.dsh/.env` | 离线测试静默打真实 API，`resilience` 测试**假通过** | 修 fail-closed 时发现断言无法触发 |
| 9 | `getClient` 只看 `ctx.get`，忽略 `ctx.typesafe` | 注入的客户端被静默替换为未配置实例 | 新单测暴露（Mock 未被使用） |
| 10 | `pnpm install --frozen-lockfile` 在干净 clone 失败 | CI 首次 push 即红（manifest 与 lockfile 不一致 + peer 未入 lockfile） | 全新 clone 跑 CI 等价流程 |
| 11 | 文档写 `timeoutMs` 默认 `10000`，代码为 `2000` | 照着调参的人拿到错误前提 | 文档一致性测试（写完首次运行即失败） |
| 12 | `doctor` 的判定信号被验证脚本覆写 | 陈旧宿主看起来「已重载」，**几乎导致误报实机验证通过** | 自查 doctor 输出矛盾（`OK` vs `ACTION`） |
| 13 | 单测套件自身写实机指标文件 | 同上（v2 指标由测试写入） | 对比运行前后文件版本 |
| 14 | 验证脚本向标定数据集追加 mock 判决 | 阈值复核会读到植入数据（一次 +6 条） | 同一污染类的扩散排查 |
| 15 | README 安装指令对 `desktop` profile 无效 | CLI 直接拒绝，用户无指引 | 实跑文档里的命令 |
| 16 | `skill-router` 用 800ms 建议超时跑 112 问请求 | **7/7 用例全部超时**且被装配钩子静默吞掉 → 默认开启的模块从不给建议 | 线上路由验证（mock 覆盖无法发现） |
| 17 | `skill-router` 在请求字面点名技能时仍可能选错 | 「SWOT 分析」选中 `company-intel`，而目录含 `swot-analysis` | 线上路由验证的标注用例 |

另有一类**结论被推翻**的记录，同样值得留档：第 34–35 轮曾把「Jev 无法判断输出中哪一部分重要」写入文档，第 36 轮的对照实验发现真因是**请求打包方式**（把项放进 state 再按索引指代），换用「行形状聚类 + 内容嵌入问题」后分类完全可靠。教训：**「模型做不到」的结论必须先排除「我请求写错了」**。

## 主动保留的限制

- **2 条死循环漏报**（基准中）：一条是完全重复（生产由 DSH 内置 `repeat-tool-reminder` 负责，本插件默认让位）；一条模型自身置信度 0.42 低于门槛。`minConfidence` 以**误报优先**为设计约束。
- **1 条跨语言路由漏报**：中文请求点名英文技能名时可能选中语义上说得通的邻近技能（已标记为 `knownMiss`）。
- **`result-shaper` 默认关闭**：它改变模型所见（只留 warning/failure 类行），必须由部署方显式开启。
- **基准不报费用**：bench 直连客户端，未挂会话指标；真实费用看 `/api/dsh-jev/stats`。
- **实机端到端未验证**：宿主进程未重载，运行中的仍是 0.1.0 构建。

## 如何自行复现

```bash
pnpm install --frozen-lockfile
pnpm test                 # 离线用例，不联网、不需要 Key
pnpm run verify:dsh       # 真实 DSH 服务集成（无 DSH 时跳过）
pnpm run verify:live      # 历史误报形态回放
pnpm run verify:tools     # 三个决策原语
pnpm run verify:shaper    # 结果整形对四类真实输出
pnpm run verify:pruner    # 工具剪枝的排序质量
pnpm run verify:router    # skill 路由（真实目录）
pnpm run bench:offline    # 30 条基准，零成本
pnpm run doctor           # 本机是否真的在跑当前构建
```

## 待人工动作

重启 DSH 桌面端。重启后：

```bash
pnpm run doctor
# 期望：OK: the running host is using the current build
```

`~/.dsh/jev-stats.json` 的 `version` 应从 `1` 变为 `2`——这是运行中的插件已切换到 0.2.0 的判据。
