# dsh-jev

[![CI](https://github.com/zhangxaochen/dsh-jev/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangxaochen/dsh-jev/actions/workflows/ci.yml)

Jev (TypeSafe System One 决策模型) 与 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的官方 Cordis 插件组合包体系。

通过引入 ~150ms 极低延迟的非生成式语义决策原语（Noul、Choice、Score），为 dsh 提供**动态工具剪枝（降 Token 提速）**、**语义死循环阻断（智能自愈）**与**高危执行安全门禁**。

---

## 核心能力

| 模块 | 拦截切面 / 服务 | 解决的核心痛点 |
| :--- | :--- | :--- |
| **`typesafe-client`** | 注册 `ctx.typesafe` | 封装 TypeSafe Jev System One API，支持多原子问题单次并发评估、超时重试与测试 Mock 模式。 |
| **`typesafe-loop-guard`** | `tools/post-execute` | 突破传统参数哈希去重局限，语义级评估每步是否产生有效解题增量，精准拦截死循环并在 `additionalContexts` 注入纠偏反思。 |
| **`typesafe-safety-guard`** | `tools/pre-execute` | 毫秒级审查 Shell/PTC/文件操作中的高危破坏性行为（如 `rm -rf`、越狱提权、凭据泄露），触发阻断（`deny`）或审批（`ask`）。 |
| **`typesafe-tool-pruner`** | `ctx.toolPruner` | 面对包含几十上百个 MCP / 本地 Tools 的场景，依据意图动态打分并只注入最相关 Top-K 工具，大幅减少 Prompt Token 消耗并降低首字延迟（TTFT）。 |
| **`jev_ask` / `jev_rank` / `jev_check`** | 注册为 Agent 工具 | 把决策原语交给模型自己：一次请求批量提问、按准则排序候选、验证断言并区分「成立 / 不成立 / 无法判定」。 |
| **`typesafe-skill-router`** | `system-prompt/assemble` | Skill 目录达到阈值时，为当前请求指出**一个**最该载入的 skill 并作为建议注入（advisory，不阻断、不删减）。 |
| **`typesafe-result-shaper`** | `tools/post-execute`（**默认关闭**） | 对超长且明显重复的命令输出做语义选段：保留有信息量的中段、丢弃噪声，只改模型可见内容。 |

`pnpm run verify:turn` 一整轮（全部模块 + 真实模型 + 真实装配）的实测输出：

```
assemble:       2139ms -> 12 tools to 5 (edit_file,git_commit,git_push,read_file,run_tests)
skill intent:   把这份用户调研整理成一份 PRD 文档 -> 1 advice in 979ms
post-execute:   586ms -> 32680 to 237 chars
semantic overhead this turn: 3704ms
```

`verify:live` 中真循环 `pLoop=0.88`、置信度 `0.81` 命中，健康轨迹 `pLoop=0.00` 不触发；`verify:pruner` 在「提交并推送」意图下只保留 `git_commit` / `git_push` / `run_tests`。数值随请求与输出规模变化，完整标定见 [`docs/calibration.md`](docs/calibration.md)。

---

## 兼容性

- **Node**：`^22.19.0 || >=24.0.0`
- **DSH**：`>=0.1.5-rc.2`。插件挂载 `tools.guard()`、`tools/pre-execute`、`tools/post-execute`、`system-prompt/assemble`、`agent/pre-step`，并按需读取 `tokenMeter` / `skills` / `toolResultPruner` 服务；这些在 0.1.5-rc.2 之外的版本上未经验证。
- 缺失任一可选服务时按降级路径工作（例如没有 `tokenMeter` 时工具剪枝回退到公开的字符/token 常量并标注口径）。

---

## 安装与配置

### 1. 配置 API Key

`dsh-jev` 依托 TypeSafe System One（Jev）决策模型执行高频毫秒级判定，需配置 `TYPESAFE_API_KEY`。**最简**：写进 `$DSH_HOME/.env`（默认 `~/.dsh/.env`），桌面端与所有 CLI profile 启动时都会自动载入：

```bash
TYPESAFE_API_KEY=your_typesafe_api_key_here
```

其它方式：系统环境变量（`export TYPESAFE_API_KEY=...`，Windows 用 `[Environment]::SetEnvironmentVariable(..., "User")`），或在 `cordis.patch.yml` 的 `client.apiKey` 中指定（补丁是整行替换，见下面「3. 修改默认阈值」）。未配置 Key 时 DSH 不会崩溃，插件记 Warn 并按 Mock 模式运行，只是无法发起云端语义仲裁。

> ⚠️ **失败策略**：受保护工具上**判定拿不到**（超时/报错/上游不可达）默认**放行**（`onError: allow`）——判定服务是运行期依赖，fail-closed 会让上游一抖就锁死宿主所有受保护工具；放行时命中确定性外壳仍拒绝（`rm -rf /` 类不需要模型），失败计入 `inspectionFailures` 并告警。**裁决到达但不可用**仍 fail-closed（`onUncertain`，默认 `deny-guarded`）。取舍详见下面 `SafetyGuardConfig.onError`。

### 2. 安装：`dsh plugin add`（自动激活为 Bundle）

DSH 原生支持 Bundle 机制，这条命令会自动安装依赖并激活该插件层，也是唯一的安装路径：

```bash
# 从 GitHub 仓库直接安装（免 npm 发包，即装即用）
dsh plugin --profile <profile_name> add github:zhangxaochen/dsh-jev

# 或发布至 npm 后；也适用于 headless / web 等具体 profile
dsh plugin --profile headless add dsh-jev
```

> ⚠️ **`desktop` profile 不能这样装**。CLI 会直接拒绝：
> `error: profile "desktop" is managed exclusively by the Electron application`。
> 桌面端请通过应用内的插件入口安装，或按「让改动在本机生效」一节把包同步到
> `~/.dsh/profiles/desktop/node_modules/dsh-jev`（`pnpm run sync` 就是这么做的）。
>
> `dsh plugin` 本身不含子命令，它把**参数转发给该 profile 目录下的 pnpm**（实测报错信息：
> `plugin needs pnpm arguments to forward (e.g. add <package>)`），因此 `add` / `remove` / `list`
> 都是 pnpm 的语义。

### 3. 修改默认阈值

装完即是可用默认值；**不改阈值就不用看这一节**。

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

### 4. 编程式挂载：嵌入非 DSH 的 Cordis 宿主（可选）

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
- 缺少 `skills` / `system-prompt` / `tokenMeter` 等宿主服务时按降级路径工作，见上面「兼容性」。

---

## 从 0.1.0 升级到 0.2.0

破坏性变更，升级后检查三处（完整变更史见 [`CHANGELOG.md`](CHANGELOG.md)）：

- `loopGuard.stuckSeverityThreshold` **已移除**（旧值在代码里被反向三元改成固定 1.4）；改用 `pLoopThreshold`（默认 `0.6`）+ `minConfidence`（默认 `0.5`）。
- `safetyGuard` 失败策略：出错/超时默认**放行**（`onError: allow`，并记账告警），**裁决不可用** fail-closed，headless 下 `ask` → `deny`。要严格设 `onError: deny-guarded`；想连「不可用」也放行设 `onUncertain: allow`。
- 指标文件 `~/.dsh/jev-stats.json` 升到 `version: 2`（只记实测字段），旧文件**不迁移**，插件启动时按新结构重新计数；需保留历史先自行备份。

同时新增：`jev_ask` / `jev_rank` / `jev_check` 决策原语、`skillRouter`、默认关闭的 `resultShaper`。

## 配置参考

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
- `headless?: boolean`: 会话无法弹窗询问时设为 `true`（默认 `false`）。此时任何 `ask`（含用户规则触发的）都转为 `deny`——宁可拒绝也不假装已获批准。桌面端保持默认即可。
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

判定单元是**行形状**：先把只差数字/哈希的行归为一类，再对每类的代表行做**有界分类**，只有 `warning` / `failure` 两类留下（实测依据见 [`docs/calibration.md`](docs/calibration.md) §9）。

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

### `TypeSafeSuiteConfig` 开关

套件配置按模块**嵌套**；未出现的模块取代码默认值（补丁是整行替换，见上面「3. 修改默认阈值」）：

- `client?: TypeSafeClientConfig`: 客户端配置（`apiKey`、超时、缓存等），见上一节。
- `loopGuard?: LoopGuardConfig | boolean`: 死循环判定（默认 `true`）。
- `safetyGuard?: SafetyGuardConfig | boolean`: 语义安全裁决（默认 `true`）。
- `toolPruner?: ToolPrunerConfig | boolean`: 工具剪枝（默认 `true`）。
- `askTools?: boolean`: 是否注册 `jev_ask` / `jev_rank` / `jev_check`（默认 `true`）。
- `skillRouter?: SkillRouterConfig | boolean`: 语义 skill 路由（默认 `true`）。
- `resultShaper?: ResultShaperConfig | boolean`: 语义结果整形，需显式开启（默认 **关闭**）。

### `ToolPrunerConfig`
- `maxTools?: number`: 上下文中最多保留的动态工具数量（默认 `8`）。
- `minScoreThreshold?: number`: 工具入选的最低相关性打分；实测刻度为 `[0, 2]`（3 级 rubric，默认 `2`）。
- `alwaysRetain?: string[]`: 永远不被剪枝保留的核心工具（默认包含 `read_file`, `write_to_file`, `bash`, `run_command`）。
- `minKeep?: number`: 即便没有工具达到阈值也至少保留几个（默认 `3`）。阈值 `2` 只认「高度相关」，实测多步意图下 12 个工具只剩 1 个（调研类意图在空保留表下甚至为 0）；下限从剩余候选中按分数补齐。
- **顺序稳定性**：剪枝只决定「哪些工具留下」，不决定它们的排列——返回结果保持上游 `orderTools` 的顺序（`alwaysRetain` 工具也不会被提到最前）。工具块位于请求前部，顺序每轮变化会让可复用的前缀失效，因此刻意不做相关性排序。
- 目标过短时**跳过剪枝**（剪枝器的 `minIntentChars`，默认 8 个字符）：实测空目标下排序失去依据——同一候选列表会保留 `deploy_service` 却丢掉 `run_tests`，且逐次不同。

---

## 与 DSH 内置能力的分工

Jev 只做 DSH 自己没有的那一层，避免重复与相互抵消：

| 场景 | 归属 | 原因 |
|---|---|---|
| 完全相同（工具+参数+输出）的重复调用 | DSH `dsh-repeat-tool-reminder`（阈值 3/5/8） | 确定性精确匹配已经够用；dsh-jev 默认 `loopGuard.deferExactRepeats: true` 主动让位 |
| **近似/语义层面的停滞** | dsh-jev `loop-guard` | 内置包明确「近义变体不做，缺证据」；本插件用死循环桶概率 + 置信度补上 |
| 超长结果的 head/tail 截断 | DSH `dsh-spill-policy`、`dsh-compaction-tool-result-pruner` | 二者是 model-free、零成本、可复现的安全替换 |
| **中段的语义选段** | dsh-jev `result-shaper`（默认关闭） | 内置包 Dev Note 把「semantic middle selection」列为未实现；本插件只补这一块 |
| 危险命令的硬拒止 | dsh-jev 确定性外壳（`ctx.tools.guard()`） | 同步、单调、0 次模型调用；语义层不承担最后一道 |
| 语义级风险裁决 / 用户自定义规则 | dsh-jev `safety-guard` | 模式列表之外的形态只能靠语义判定 |

## 本地开发与测试

Node 原生测试运行器，离线用例不联网、不需要 Key（内置 Mock）：

```bash
pnpm install --frozen-lockfile
pnpm run build && pnpm run verify:build   # lib/ 入库且单测导入的是它，改了 src 忘记重建必须报错
pnpm test                                 # 离线单测（用例数随版本增长，以输出为准）
pnpm run verify:dsh                       # 真实 DSH runtime（未安装 DSH 时跳过并退出 0，可用于 CI）
pnpm run verify:live                      # 线上：回放历史误报形态，确认误报消失且真循环仍被拦截
pnpm run bench:offline                    # 回放录制答案的 A/B 基准，零成本、无需 Key
pnpm run doctor                           # 部署自检：本机跑的是不是当前构建
```

其余闸门——`probe` / `verify:tools` / `verify:pruner` / `verify:router` / `verify:shaper` / `verify:turn` / `verify:pack` / `verify:mutants` / `verify:solo` / `drill` / `bench` / 覆盖率审计——的命令与各自证据见 [`docs/verification-report.md`](docs/verification-report.md)；阈值来源见 [`docs/calibration.md`](docs/calibration.md)；借鉴项与其证据见 [`docs/research.md`](docs/research.md)；分阶段清单见 [`docs/OPTIMIZATION_PLAN.md`](docs/OPTIMIZATION_PLAN.md)；行为变更史见 [`CHANGELOG.md`](CHANGELOG.md)。

CI（`.github/workflows/ci.yml`）在 Node 22 与 24 上跑 `build → typecheck:scripts → test → bench:offline → verify:dsh（跳过）→ 打包校验`：基准是离线回放的且带**输入指纹校验**，因此不需要 API Key；**任何未标记为已知漏报的用例行为不符都会让 CI 失败**。

### 让改动在本机生效

profile 里的插件是**构建产物的副本**，改完源码必须同步，然后重启 DSH：

```bash
pnpm run sync              # 同步到所有已安装该插件的 profile（自动发现）
pnpm run sync:desktop      # 只同步 desktop
pnpm run doctor            # 逐 profile 比对构建哈希、安装版本与指标 schema，输出 ACTION: 或 OK:
```

`pnpm run sync` 同时把 profile 清单里声明的 `dsh-jev` 版本对齐到本仓库版本：声明是精确版本而安装副本是**原地替换**的，两者漂移后该 profile 里任何一次 `pnpm install`（`dsh plugin add` 都会跑）会把新版本**静默换回**声明版本；`doctor` 会报出这类漂移（`declaredMatch`）。验证脚本不会污染实机指标——`verify:*` / `bench` 都把指标与决策日志写到 `%TEMP%`（`DSH_JEV_METRICS_PATH` / `DSH_JEV_DECISIONS_PATH`），否则 `~/.dsh/jev-stats.json` 会被测试覆写，而那正是 `doctor` 判断部署状态的依据。

> ⚠️ **必须重启 DSH**：本部署的 profile 组合里没有挂载 HMR 插件，运行中的进程不会重新加载 `node_modules` 下的模块。只同步不重启，会话里跑的还是旧构建（`doctor` 会明确报 `ACTION: restart DSH`）。

---

## 指标与总开关

- **看板**：让 Agent 执行 `jev_stats`，或请求 `GET /api/dsh-jev/stats`（浏览器得到 HTML 仪表盘，`Accept: application/json` 得到结构化 JSON）。指标持久化在 `~/.dsh/jev-stats.json`，调用时传 `{ "reset": true }` 或删除该文件即归零。工具 Schema 的精确移除字符数可核对；死循环与安全拦截只报计数，不做不可测的 token 折算。
- **状态栏总开关**：输入框下方状态栏（`conversation.input.right` 插槽）有一个 `jev` switcher——轨道绿色=启用全部模块，灰色=全部直通（不剪枝、不路由、不整形、不拦截），虚线=读不到状态（宿主路由尚未注册，不猜）。点一下即切换，**无需卸载或重启**：各模块在每次决策前读取开关。状态持久化在 `~/.dsh/jev-enabled.json`，也可用 `curl 'http://<host>:<port>/api/dsh-jev/stats?enabled=0'`（`0` 停用 / `1` 启用）或直接改该文件切换。
- ⚠️ **停用是彻底的**：连**确定性硬拒层**（无需模型调用的那一层，例如递归删除根目录）也一并停止拦截——留隐藏例外会造成「看到关闭却仍被拦」的困惑，故不设例外。文件缺失、损坏或不可读时**一律视为启用**：文件系统故障不该悄悄关掉护栏。

---

## 许可证

[MIT](LICENSE)
