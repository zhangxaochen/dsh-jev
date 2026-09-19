# 配置与嵌入

`dsh-jev` 装完即是可用默认值。这里是参考手册：改阈值、自定义安全规则、嵌入非 DSH 的 Cordis 宿主、运行时总开关。README 只讲怎么装和怎么用。

## 覆盖默认阈值

> ⚠️ **补丁是「整行替换」，不是逐键合并。** DSH 自身的补丁文件写明了这一点：
> *"A patch replaces the targeted row's whole `config` rather than merging into it … the last write winning per row."*
> 因此只写一行 `loopGuard.pLoopThreshold: 0.7`，会让该条目的其余配置（`guardedTools`、`alwaysRetain`、`client.apiKey`…）一起回到代码默认值。

起点用**安装副本**，不要用文档里的副本：`cordis.patch.yml` 随包发布，并被 `tests/packaging.spec.ts` 钉在代码默认值上。

```bash
# 1. 复制已安装副本作为起点（<profile> 换成实际 profile 名）
cp "$DSH_HOME/profiles/<profile>/node_modules/dsh-jev/cordis.patch.yml" ~/.dsh/cordis.patch.yml

# 2. 只改你要改的值，其余整行原样保留

# 3. 确认真正生效的那份配置（输出带 patch 层来源注释）
dsh --profile <profile> --dump-config
```

- 用户 patch 有两个位置：全局 `$DSH_HOME/cordis.patch.yml` 与 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`；**先应用 profile 级、再应用 home 级**，因此全局文件优先级更高。
- 空文件或只有注释会让启动失败；要停用该层请写 `[]`。

## 运行时总开关（启用 / 停用）

输入框下方状态栏（`conversation.input.right` 插槽）有一个 `jev` switcher：轨道**绿色**=启用全部模块；灰色=全部直通（不剪枝、不路由、不整形、不拦截）；虚线=读不到状态（宿主路由尚未注册，不猜）。点一下即切换，**无需卸载或重启**——各模块在每次决策前读取开关，状态立即生效。

状态持久化在 `~/.dsh/jev-enabled.json`，也可用 `curl 'http://<host>:<port>/api/dsh-jev/stats?enabled=0'`（`0` 停用 / `1` 启用）或直接改该文件。

> ⚠️ **停用是彻底的**：连**确定性硬拒层**（无需模型调用的那一层，例如递归删除根目录）也一并停止拦截——留隐藏例外会造成「看到关闭却仍被拦」的困惑，故不设例外。文件缺失、损坏或不可读时**一律视为启用**：文件系统故障不该悄悄关掉护栏。

## 嵌入非 DSH 的 Cordis 宿主

`dsh plugin add` 已按 Bundle 挂载全部模块，DSH 用户不需要这一节。每个模块都导出 `name` + `apply`，可当作普通 Cordis 插件挂载：

```ts
import { Context } from '@deepseek-ai/cordis'
import { registerJevTools, resolveClientFrom } from 'dsh-jev'
import * as TypeSafeClient from 'dsh-jev/typesafe-client'   // 服务层；注意不是 dsh-jev/client
import * as LoopGuard from 'dsh-jev/loop-guard'
import * as SafetyGuard from 'dsh-jev/safety-guard'
import * as ToolPruner from 'dsh-jev/tool-pruner'
import * as SkillRouter from 'dsh-jev/skill-router'
import * as ResultShaper from 'dsh-jev/result-shaper'   // 默认关闭，需显式挂载

const ctx = new Context()

ctx.plugin(TypeSafeClient, { apiKey: process.env.TYPESAFE_API_KEY })
ctx.plugin(LoopGuard, { triggerThreshold: 2, noProgressThreshold: 0.3 })
ctx.plugin(SafetyGuard, { blockThreshold: 0.85, onError: 'allow' })
ctx.plugin(ToolPruner, { maxTools: 8, minScoreThreshold: 2 })
ctx.plugin(SkillRouter, { minScore: 1.5, minConfidence: 0.5 })
ctx.plugin(ResultShaper, { thresholdChars: 8000, maxPerTurn: 2 })

// 决策原语不经 ctx.plugin 挂载，而是注册为 Agent 工具（整包挂载时由 askTools 默认开启）
registerJevTools(ctx, () => resolveClientFrom(ctx))
```

- `dsh-jev/client` 是宿主 `client-modules` 加载的**浏览器端**面板（设置项 + 状态栏开关），由 DSH 按 `package.json` 的 `dsh.client` 自动加载。它不导出 `apply`，拿它 `ctx.plugin()` 会直接抛 `invalid plugin`。
- 缺少 `skills` / `system-prompt` / `tokenMeter` 等宿主服务时按降级路径工作。

## 失败策略（判定服务不可用、或会话无法询问时）

受保护工具（`guardedTools`）上的**判定拿不到**（超时/报错/上游不可达）时默认**放行**（`onError: allow`）——判定服务是运行期依赖，fail-closed 会让上游一抖就把宿主所有受保护工具（含 shell）锁死。放行时**仍会**：命中确定性外壳即拒绝（`rm -rf /` 类不需要模型）、失败计入 `inspectionFailures` 并告警。**裁决到达但不可用**（模型没给出可用概率）仍 fail-closed（`onUncertain`，默认 `deny-guarded`）。若你的威胁模型认为「判定服务不可达本身就是攻击面」，在自己的补丁层钉 `onError: deny-guarded`。

会话**无法弹窗**（headless / CI）时，落进 `ask` 区间的调用默认**放行并告警**（`headlessAsk: warn`，计数进 `safetyGuard.warned`）——`ask` 的本意是「该由人决定」，把「问不到人」变成拒绝等于拿护栏惩罚 agent（实测：两次 hazard 0.50 / 0.72 的询问被硬拒后，该臂步数 +12%、耗时 +17%）。无人值守的严格部署设 `headlessAsk: 'deny'` 恢复 fail-closed。两种取值都**不影响**硬拒区间（`blockThreshold` 及以上）与确定性外壳。

## 配置参考

套件配置按模块**嵌套**；未出现的模块取代码默认值（补丁是整行替换，见上面「覆盖默认阈值」）：

- `client?: TypeSafeClientConfig`: 客户端配置（`apiKey`、超时、缓存等），见下。
- `loopGuard?: LoopGuardConfig | boolean`: 死循环判定（默认 `true`）。
- `safetyGuard?: SafetyGuardConfig | boolean`: 语义安全裁决（默认 `true`）。
- `toolPruner?: ToolPrunerConfig | boolean`: 工具剪枝（默认 `true`）。
- `askTools?: boolean`: 是否注册 `jev_ask` / `jev_rank` / `jev_check`（默认 `true`）。
- `skillRouter?: SkillRouterConfig | boolean`: 语义 skill 路由（默认 `true`）。
- `resultShaper?: ResultShaperConfig | boolean`: 语义结果整形，需显式开启（默认 **关闭**）。

### `TypeSafeClientConfig`
- `apiKey?: string`: TypeSafe API Key（默认优先读取环境变量 `TYPESAFE_API_KEY`）。
- `baseUrl?: string`: API 地址（默认 `https://api.typesafe.ai/v1/systemone`）。
- `model?: string`: 决策模型（默认 `jev-latest`）。
- `timeoutMs?: number`: 交互式请求超时，单位毫秒（默认 `2000`）。实测热调用 250–300ms、冷启动 700–750ms。
- `pathTimeoutMs?: number`: 后置建议路径（死循环判定、安全语义裁决、结果整形）的超时，单位毫秒（默认 `800`）。
- `cacheTtlMs?: number`: 相同载荷结果的缓存有效期，`0` 关闭（默认 `30000`）。
- `mockHandler?: MockHandler`: 自定义离线 Mock 处理器，常用于自动化测试或离线断网环境。

### `LoopGuardConfig`
- `triggerThreshold?: number`: 连续无进展步数达到该值后开始语义评估（默认 `2`）。
- `noProgressThreshold?: number`: `has_progress` 概率低于该值即视为无进展，范围 0~1（默认 `0.3`）。
- `pLoopThreshold?: number`: 「确定死循环」桶的概率质量阈值，范围 0~1（默认 `0.6`）。实测：真循环 `0.86`、正常探索 `0.00`、误报样本约 `0.4`。
- `minConfidence?: number`: 答案置信度低于该值则不动作，范围 0~1（默认 `0.5`）。
- `cooldownSteps?: number`: 一次提示后的静默步数（默认 `3`）。
- `maxHistory?: number`: 每 agent 保留的历史窗口（默认 `8`）。
- `deferExactRepeats?: boolean`: 完全相同（工具+参数+输出）的重复交给 DSH 内置 `repeat-tool-reminder` 处理，不走语义判定（默认 `true`）。
- `include?: string[]`: 跟踪的特定工具列表（为空则跟踪所有）。
- `exclude?: string[]`: 忽略的工具列表。

### `SafetyGuardConfig`
- `blockThreshold?: number`: 阻断执行（返回 `deny`）的危害概率阈值（默认 `0.85`）。
- `askApprovalThreshold?: number`: 请求人工审批（返回 `ask`）的风险概率阈值（默认 `0.5`）。
- `onError?: 'deny-guarded' | 'deny-all' | 'allow'`: **判定拿不到**（API 报错/超时/上游不可达）时的策略，默认 **`allow`**。理由是判定服务属运行期依赖，fail-closed 会把上游抖动放大成「所有受保护工具被拒」；确定性外壳不受此设置影响（`rm -rf /` 照旧拒绝），失败也会计数告警。要严格就设 `deny-guarded`。
- `inspectionTimeoutMs?: number`: **语义审查**的超时预算（默认 `3500`）。刻意**不复用** `client.pathTimeoutMs`（800ms 属**建议路径**，失败放行无代价；这里失败即拒绝受保护工具），实测调用耗时 587–777ms，用 800ms 等于把预算压在实测天花板上。
- `inspectionRetries?: number`: **瞬时**失败（超时/中断/429/5xx）的额外尝试次数（默认 `1`）。只对瞬时错误重试，「裁决不可用」（答案到了但不可用）不走重试、归 `onUncertain`；重试与最终失败次数都计入看板（`inspectionRetries` / `inspectionFailures`）。
- `onUncertain?: 'deny-guarded' | 'deny-all' | 'allow'`: 拿到了答案但没有可用概率时的策略，默认 `deny-guarded`。
- `rules?: Array<{ id, question, threshold?, action? }>`: 用户自定义语义规则，与内置问题同一次请求评估；`action` 可取 `deny` / `ask` / `warn`。
- `headless?: boolean`: 会话无法弹窗询问时设为 `true`（默认 `false`；也可由 `HEADLESS` / `CI` / `DEEPSEEK_HARNESS_HEADLESS` 环境变量推断）。它只声明「问不到人」，`ask` 的处置由 `headlessAsk` 决定。桌面端保持默认即可。
- `headlessAsk?: 'warn' | 'deny'`: 无法弹窗时对 `ask` 的处置，默认 **`warn`**（放行并告警，计数进 `safetyGuard.warned`）；设 `deny` 恢复 fail-closed（宁可拒绝也不假装已获批准）。两者都**不影响**硬拒区间（`blockThreshold` 及以上）与确定性外壳。
- `guardedTools?: string[]`: 受到审查保护的高危工具列表。库默认 = `bash` / `terminal` / `pwsh` / `run_command` / `execute_command` / `run_code` / `write_to_file` / `replace_file_content`；随包 `cordis.patch.yml` 与之一致（含文件写入，因为凭据常被写进仓库文件）。`tests/packaging.spec.ts` 会阻止发布配置把这份清单改小。

### `SkillRouterConfig`
- `minCandidates?: number`: 目录小于该规模不做路由（默认 `8`）。
- `minIntentChars?: number`: 请求文本短于该长度不做路由（默认 `12`）。
- `minScore?: number`: 建议 skill 的最低适用性打分，刻度 `[0, 2]`（默认 `1.5`）。
- `minConfidence?: number`: 建议所需的最低答案置信度（默认 `0.5`）。
- `requestTimeoutMs?: number`: 路由请求自身的超时（默认 `4000`）。**实测：112 个技能一次的请求耗时 1.36–1.45s**，沿用 800ms 的建议路径超时会让路由**每次都失败且被静默吞掉**。
- `nameMatchBoost?: number`: 请求**字面点名**某个技能时给它的加分（默认 `0.6`）。实测「对这个新产品做一次 SWOT 分析」在无此加成时会输给 `company-intel`。
- `maxCandidates?: number`: 可选候选上限；`0` 表示把整个目录送去排序（默认 `0`）。设成非零会启用**词法**预筛，对「请求语言与技能描述语言不同」的场景有丢正确项的风险，故默认关闭。
- **语义**：同一意图只在首次装配时给出一次建议；每轮装配最多一条 `typesafe-skill-router` 条目（同名替换而非堆叠）；低于阈值或 `skills.list()` 抛错时保持沉默。

### `ResultShaperConfig`（**默认关闭**）

判定单元是**行形状**：先把只差数字/哈希的行归为一类，再对每类的代表行做**有界分类**，只有 `warning` / `failure` 两类留下（实测依据见 [`calibration.md`](calibration.md) §9）。

- `shapeTools?: string[]`: 允许整形的输出密集型工具（默认 `bash` / `pwsh` / `terminal` / `run_command` / `execute_command`）。
- `thresholdChars?: number`: 触发整形的最小内容长度（默认 `8000`）。
- `maxPerTurn?: number`: 每轮最多整形几次（默认 `2`）。
- `keepKinds?: string[]`: 保留下来的类别（默认 `warning`, `failure`）；可选类别为 `routine_progress` / `summary` / `warning` / `failure`。
- `minKindConfidence?: number`: 分类置信度低于该值时该类**保留**（默认 `0.6`）。
- `maxClusters?: number`: 单次请求最多分类的行形状数，超出的类别一律保留（默认 `24`）。
- `sampleChars?: number`: 每类代表行送入分类的字符数（默认 `400`）。
- `requestTimeoutMs?: number`: 分类请求自身的超时（默认 `4000`）。
- 前置检查：单行 >4000 字符、行数 ≥120、或结构重复率 ≥50% 才发起判定；类别全部被丢弃时**拒绝整形**原样返回，且同一轮内不再重试。
- ℹ️ 该模块仍是 **opt-in / 实验性**：分类本身可靠，但「保留 warning/failure、丢弃其余」意味着普通细节也会被丢弃——请按你的输出形态决定是否开启。

### `ToolPrunerConfig`
- `maxTools?: number`: 上下文中最多保留的动态工具数量（默认 `8`）。
- `minScoreThreshold?: number`: 工具入选的最低相关性打分；实测刻度为 `[0, 2]`（3 级 rubric，默认 `2`）。
- `alwaysRetain?: string[]`: 永远不被剪枝保留的核心工具（默认包含 `read_file`, `write_to_file`, `bash`, `run_command`）。
- `minKeep?: number`: 即便没有工具达到阈值也至少保留几个（默认 `3`）。阈值 `2` 只认「高度相关」，实测多步意图下 12 个工具只剩 1 个（调研类意图在空保留表下甚至为 0）；下限从剩余候选中按分数补齐。
- **顺序稳定性**：剪枝只决定「哪些工具留下」，不决定它们的排列——返回结果保持上游 `orderTools` 的顺序（`alwaysRetain` 工具也不会被提到最前）。工具块位于请求前部，顺序每轮变化会让可复用的前缀失效，因此刻意不做相关性排序。
- 目标过短时**跳过剪枝**（剪枝器的 `minIntentChars`，默认 8 个字符）：实测空目标下排序失去依据——同一候选列表会保留 `deploy_service` 却丢掉 `run_tests`，且逐次不同。
