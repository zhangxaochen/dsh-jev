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

---

## 兼容性

- **Node**：`^22.19.0 || >=24.0.0`
- **DSH**：`>=0.1.5-rc.2`。插件挂载 `tools.guard()`、`tools/pre-execute`、`tools/post-execute`、`system-prompt/assemble`、`agent/pre-step`，并按需读取 `tokenMeter` / `skills` / `toolResultPruner` 服务；这些在 0.1.5-rc.2 之外的版本上未经验证，因此 `engines.dsh` 不再声称兼容 0.1.0。
- 缺失任一可选服务时按降级路径工作（例如没有 `tokenMeter` 时工具剪枝回退到公开的字符/token 常量并标注口径）。

## 准备工作：配置 API Key

`dsh-jev` 依托 TypeSafe System One（Jev）决策模型执行高频毫秒级判定，需配置 `TYPESAFE_API_KEY`。

### 推荐方式：写入 DSH 全局配置文件（最简）

DeepSeek Harness 桌面端（Desktop）及所有 CLI profiles（Headless / Web / TUI）在启动时均会自动载入 `$DSH_HOME/.env`（默认位于 `~/.dsh/.env`）。

在 `~/.dsh/.env` 中添加一行即可全局生效：
```bash
TYPESAFE_API_KEY=your_typesafe_api_key_here
```

### 其它方式：
- **系统环境变量**：
  - Linux / macOS: `export TYPESAFE_API_KEY="your_api_key"`
  - Windows (PowerShell): `[Environment]::SetEnvironmentVariable("TYPESAFE_API_KEY", "your_api_key", "User")`
- **代码 / YAML 显式指定**：在 `cordis.patch.yml` 的 `client.apiKey` 中指定。

> ℹ️ **说明**：未配置 Key 时，DSH 不会崩溃，插件会记录 Warn 警告日志，此时可作为 Mock 模式运行；但在真实执行中将无法向云端发起 System One 语义仲裁。

> ⚠️ **失败策略**：受保护工具（`guardedTools`）上的语义判定一旦超时、报错或返回不可用结果，默认 **fail-closed（拒绝执行）**，headless 环境同样如此。需要旧的「出错即放行」行为时显式设置 `safetyGuard.onError: allow`。

---

## 安装与挂载

### 方式 1：DSH 官方命令行一键安装（推荐，自动激活为 Bundle）

DSH 原生支持 Bundle 机制，执行以下命令会自动安装依赖并激活该插件层：

```bash
# 从 GitHub 仓库直接安装（免 npm 发包，即装即用）
dsh plugin --profile <profile_name> add github:zhangxaochen/dsh-jev

# 或发布至 npm 后
dsh plugin --profile <profile_name> add dsh-jev
```

例如为 `headless` 或 `web` 激活：
```bash
dsh plugin --profile headless add github:zhangxaochen/dsh-jev
```

> ⚠️ **`desktop` profile 不能这样装**。CLI 会直接拒绝：
> `error: profile "desktop" is managed exclusively by the Electron application`。
> 桌面端请通过应用内的插件入口安装，或按「让改动在本机生效」一节把包同步到
> `~/.dsh/profiles/desktop/node_modules/dsh-jev`（`pnpm run sync` 就是这么做的）。
>
> `dsh plugin` 本身不含子命令，它把**参数转发给该 profile 目录下的 pnpm**（实测报错信息：
> `plugin needs pnpm arguments to forward (e.g. add <package>)`），因此 `add` / `remove` / `list`
> 都是 pnpm 的语义。

### 方式 2：在 profile 或全局 `cordis.patch.yml` 中手动挂载

若需深度定制各项阈值，可在 `$DSH_HOME/cordis.patch.yml` 或 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中添加配置：

```yaml
- insert:
    - id: dsh-jev
      name: dsh-jev
      config:
        client:
          apiKey: !!js process.env.TYPESAFE_API_KEY
        loopGuard:
          triggerThreshold: 2
          noProgressThreshold: 0.3
          pLoopThreshold: 0.6
          minConfidence: 0.5
        safetyGuard:
          blockThreshold: 0.85
          askApprovalThreshold: 0.5
          onError: deny-guarded
          onUncertain: deny-guarded
          guardedTools:
            - bash
            - pwsh
            - terminal
            - run_command
            - run_code
        # 可选：Agent 决策原语（默认 true）
        askTools: true
        # 可选：语义 skill 路由（默认 true）
        skillRouter:
          minCandidates: 8
          minScore: 1.5
        # 可选：语义结果整形，默认关闭，需显式开启
        # resultShaper:
        #   thresholdChars: 8000
        #   maxPerTurn: 2
        toolPruner:
          maxTools: 8
          minScoreThreshold: 2
          alwaysRetain:
            - read_file
            - write_to_file
            - write_file
            - edit_file
            - str_replace_editor
            - bash
            - terminal
            - pwsh
            - run_command
            - execute_command
            - grep
            - glob
            - find_by_name
            - view_file
            - replace_file_content
            - list_dir
            - directory-picker-native
            - ui-directory-picker-native
```

### 方式 3：按需挂载单独插件

你也可以仅引入所需特定守卫或客户端：

```ts
import { Context } from '@deepseek-ai/cordis'
import * as TypeSafeClient from 'dsh-jev/client'
import * as LoopGuard from 'dsh-jev/loop-guard'
import * as SafetyGuard from 'dsh-jev/safety-guard'
import * as ToolPruner from 'dsh-jev/tool-pruner'
import * as SkillRouter from 'dsh-jev/skill-router'
import * as ResultShaper from 'dsh-jev/result-shaper'   // 默认关闭，需显式挂载

const ctx = new Context()

// 挂载底层 Client 服务
ctx.plugin(TypeSafeClient, { apiKey: process.env.TYPESAFE_API_KEY })

// 单独挂载死循环阻断卫士
ctx.plugin(LoopGuard, {
  triggerThreshold: 2,
  noProgressThreshold: 0.3
})

// 单独挂载安全门禁
ctx.plugin(SafetyGuard, {
  blockThreshold: 0.85,
  onError: 'deny-guarded'
})

// 单独挂载语义 skill 路由（advisory）
ctx.plugin(SkillRouter, { minScore: 1.5, minConfidence: 0.5 })

// 单独挂载语义结果整形（改变模型所见，按需开启）
ctx.plugin(ResultShaper, { thresholdChars: 8000, maxPerTurn: 2 })
```

决策原语不经 `ctx.plugin` 挂载，而是注册为 Agent 工具（`registerJevTools(ctx, () => client)`，或直接用整包默认开启的 `askTools`）。

---

## 从 0.1.0 升级到 0.2.0

这是一次**破坏性变更**版本，升级后请检查三处：

| 变更 | 0.1.0 | 0.2.0 | 需要做什么 |
|---|---|---|---|
| `loopGuard.stuckSeverityThreshold` | 有效区间 `[0, 2]`，但代码里被反向三元改成固定 1.4 | **已移除** | 从配置里删掉该项；改用 `pLoopThreshold`（默认 `0.6`）+ `minConfidence`（默认 `0.5`） |
| `safetyGuard` 失败策略 | 出错/超时 → 放行；headless 下 `ask` → 放行 | 受保护工具 **fail-closed**，headless 下 `ask` → `deny` | 若确实需要旧行为，显式设置 `onError: allow` / `onUncertain: allow` |
| 指标文件 `~/.dsh/jev-stats.json` | `version: 1`，含两个凭空常量折算的「节省 token」 | `version: 2`，只记实测字段 | 旧文件**不迁移**，插件启动时按新结构重新计数；如需保留历史先自行备份 |

同时新增（默认值见下）：`jev_ask`/`jev_rank`/`jev_check` 决策原语、`skillRouter`、以及默认关闭的 `resultShaper`。

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
- `onError?: 'deny-guarded' | 'deny-all' | 'allow'`: 判定无法获得（API 报错/超时）时的策略，默认 `deny-guarded`（受保护工具 fail-closed，其余工具放行）。需要旧的「出错即放行」行为时显式设为 `allow`。
- `onUncertain?: 'deny-guarded' | 'deny-all' | 'allow'`: 拿到了答案但没有可用概率时的策略，默认 `deny-guarded`。
- `rules?: Array<{ id, question, threshold?, action? }>`: 用户自定义语义规则，与内置问题同一次请求评估；`action` 可取 `deny` / `ask` / `warn`。
- `guardedTools?: string[]`: 受到审查保护的高危工具列表。库默认 = `bash` / `terminal` / `pwsh` / `run_command` / `execute_command` / `run_code` / `write_to_file` / `replace_file_content`；随包 `cordis.patch.yml` 与之一致（含文件写入，因为凭据常被写进仓库文件）。`tests/packaging.spec.ts` 会阻止发布配置把这份清单改小。

### `SkillRouterConfig`
- `minCandidates?: number`: 目录小于该规模不做路由（默认 `8`）。
- `minIntentChars?: number`: 请求文本短于该长度不做路由（默认 `12`）。
- `minScore?: number`: 建议 skill 的最低适用性打分，刻度 `[0, 2]`（默认 `1.5`）。
- `minConfidence?: number`: 建议所需的最低答案置信度（默认 `0.5`）。
- `requestTimeoutMs?: number`: 路由请求自身的超时（默认 `4000`）。**实测：112 个技能一次的请求耗时 1.36–1.45s**，沿用 800ms 的建议路径超时会让路由**每次都失败且被静默吞掉**。
- `nameMatchBoost?: number`: 请求**字面点名**某个技能时给它的加分（默认 `0.6`）。实测「对这个新产品做一次 SWOT 分析」在无此加成时会输给 `company-intel`。
- `maxCandidates?: number`: 可选候选上限；`0` 表示把整个目录送去排序（默认 `0`）。设成非零会启用**词法**预筛，对「请求语言与技能描述语言不同」的场景有丢正确项的风险，故默认关闭。
- **语义**：同一意图只在首次装配时给出一次建议（指纹相同即跳过，不重复调用模型也不重复注入）；每轮装配最多一条 `typesafe-skill-router` 条目，同名替换而非堆叠；低于分/置信度阈值时保持沉默；`skills.list()` 抛错时 prompt 原样返回。

### `ResultShaperConfig`（**默认关闭**）

判定单元是**行形状**：先把只差数字/哈希的行归为一类，再对每类的代表行做**有界分类**（类别见下），
只有 `warning` / `failure` 两类留下。实测依据见 [`docs/calibration.md`](docs/calibration.md) §9。

- `shapeTools?: string[]`: 允许整形的输出密集型工具（默认 `bash` / `pwsh` / `terminal` / `run_command` / `execute_command`）。
- `thresholdChars?: number`: 触发整形的最小内容长度（默认 `8000`）。
- `maxPerTurn?: number`: 每轮最多整形几次（默认 `2`）。
- `keepKinds?: string[]`: 保留下来的类别（默认 `warning`, `failure`）；可选类别为 `routine_progress` / `summary` / `warning` / `failure`。
- `minKindConfidence?: number`: 分类置信度低于该值时该类**保留**（默认 `0.6`）。
- `maxClusters?: number`: 单次请求最多分类的行形状数，超出的类别一律保留（默认 `24`）。
- `sampleChars?: number`: 每类代表行送入分类的字符数（默认 `400`）。
- `requestTimeoutMs?: number`: 分类请求自身的超时（默认 `4000`）。
- 前置检查：单行 >4000 字符、行数 ≥120、或结构重复率 ≥50% 才发起判定；类别全部被丢弃时**拒绝整形**、原样返回，且同一轮内不再重试。
- ℹ️ 该模块仍是**opt-in / 实验性**：分类本身可靠（实测对 600 行中的单行报错给出 `failure`、置信度 1），但「保留 warning/failure、丢弃其余」意味着普通细节也会被丢弃——请按你的输出形态决定是否开启。
### `TypeSafeSuiteConfig` 开关
- `askTools?: boolean`: 是否注册 `jev_ask` / `jev_rank` / `jev_check`（默认 `true`）。
- `skillRouter?: SkillRouterConfig | boolean`: 语义 skill 路由（默认 `true`）。
- `resultShaper?: ResultShaperConfig | boolean`: 语义结果整形，需显式开启（默认 **关闭**）。

### `ToolPrunerConfig`
- `maxTools?: number`: 上下文中最多保留的动态工具数量（默认 `8`）。
- **顺序稳定性**：剪枝只决定「哪些工具留下」，不决定它们的排列——返回结果保持上游 `orderTools` 的顺序（`alwaysRetain` 工具也不会被提到最前）。工具块位于请求前部，顺序每轮变化会让可复用的前缀失效，因此这里刻意不做相关性排序。
- `minScoreThreshold?: number`: 工具入选的最低相关性打分；实测刻度为 `[0, 2]`（3 级 rubric，默认 `2`）。
- `alwaysRetain?: string[]`: 永远不被剪枝保留的核心工具（默认包含 `read_file`, `write_to_file`, `bash`, `run_command`）。

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

本项目采用 Node.js 原生测试运行器，测试执行速度极快（< 300ms），且不依赖外部网络与 API Key（内置 Mock 测试套件）：

```bash
# 编译 TypeScript
pnpm run build

# 离线单元测试（不联网、不需要 Key；用例数随版本增长，以输出为准）
pnpm test

# 探针：确认 System One 三种原语的真实返回结构（score 是 [0, n-1] 的连续期望值）
pnpm run probe

# 线上验证：回放历史误报形态，确认误报消失且真循环仍被拦截
pnpm run verify:live

# 线上验证：jev_ask / jev_rank / jev_check 三个决策原语
pnpm run verify:tools

# 集成校验：在真实 DSH runtime（真实 Cordis + 真实 waterfall）上挂载插件
# 未安装 DSH 时自动跳过并退出 0，因此可在无 DSH 的 CI 中安全运行
pnpm run verify:dsh

# 线上验证：结果整形（重写后的行形状分类）对四类真实输出是否按预期保留/丢弃
pnpm run verify:shaper

# 线上验证：工具剪枝的排序质量（带标注用例：哪些工具必须留下、哪些必须剔除）
pnpm run verify:pruner

# 线上验证：skill 路由（真实 112 项目录；含 1 条已记录的跨语言漏报）
pnpm run verify:router

# 守卫网自检：对每条承诺注入对应回归，确认至少有一道闸门拦下（需干净工作树）
pnpm run drill

# A/B 基准：30 条正负样本，输出误报/漏报/延迟/费用
pnpm run bench            # 真实 API，并录制答案到 bench/recorded.json
pnpm run bench:offline    # 回放录制答案，零成本复现
```

验证证据索引见 [`docs/verification-report.md`](docs/verification-report.md)（每条承诺对应哪种验证手段、抓到过哪些缺陷）；标定结果与阈值来源见 [`docs/calibration.md`](docs/calibration.md)；分阶段执行清单见 [`docs/OPTIMIZATION_PLAN.md`](docs/OPTIMIZATION_PLAN.md)；行为变更史见 [`CHANGELOG.md`](CHANGELOG.md)。

CI（`.github/workflows/ci.yml`）在 Node 22 与 24 上跑 `build → typecheck:scripts → test → bench:offline → verify:dsh（跳过）→ 打包校验`：基准是离线回放的且带**输入指纹校验**，因此不需要 API Key；**任何未标记为已知漏报的用例行为不符都会让 CI 失败**（不再只看总体准确率）。

### 让改动在本机生效

profile 里的插件是**构建产物的副本**，改完源码必须同步过去：

```bash
pnpm run sync              # 同步到所有已安装该插件的 profile（自动发现）
pnpm run sync:desktop      # 只同步 desktop
node scripts/sync-profiles.js --dry-run   # 只列出目标，不写文件
```

> ℹ️ **验证脚本不会污染实机指标**：`verify:dsh` / `verify:live` / `verify:tools` / `bench` 都把指标写到
> `%TEMP%` 下的临时文件（指标通过 `DSH_JEV_METRICS_PATH`，决策日志通过 `DSH_JEV_DECISIONS_PATH`）；
> 否则指标文件会以自身 schema 覆写
> `~/.dsh/jev-stats.json`，而那正是 `doctor` 判断部署状态的依据。

判定「本机是否真的在跑新构建」用一条命令：

```bash
pnpm run doctor
```

它会逐 profile 比对构建哈希、比对安装版本，并读取 `~/.dsh/jev-stats.json` 的 schema 版本，输出 `ACTION:` 或 `OK:`；`--json` 供 CI 使用，退出码 0 表示运行中的宿主已在用当前构建。

> ⚠️ **必须重启 DSH**：本部署的 profile 组合里没有挂载 HMR 插件，运行中的进程不会重新加载 `node_modules` 下的模块。只同步不重启，会话里跑的还是旧构建（`doctor` 会明确报 `ACTION: restart DSH`）。

---

## 📊 指标统计与用户收益感知

`dsh-jev` 内置了完整的指标收集与收益感知系统，自动追踪工具剪枝节省的 Schema Token、死循环熔断止损、安全门禁拦截次数以及 System One 决策延迟：

### 1. Agent 工具直接调取看板
在对话中直接让模型执行 `jev_stats`，或通过命令调取，即可输出结构化看板卡片：
```markdown
### 🛡️ TypeSafe Jev 守护与收益看板

| 守护维度 | 核心拦截/优化战果 | 预估 Token / 成本收益 |
| :--- | :--- | :--- |
| **🛠️ 工具动态剪枝** | 评估 **42** 次，裁剪 **210** 个次无关工具（精确移除 **31,500** 字符） | 省约 **9.0K** Tokens（口径：tokenMeter 估算器 / 本地启发 / 混合） |
| **🔄 死循环及早止损** | 检查 **18** 次，阻断 **2** 次、警示 **3** 次，共注入 **5** 条提示 | 不做 token 折算（避免成本不可测），仅报计数 |
| **🔒 执行安全护栏** | 审查 **65** 次，阻断 **1** 次（确定性 **1** / 判定不可用 fail-closed **0**），审批 **4** 次 | 确定性外壳 0 次模型调用即可拒止 |
| **🧩 语义结果整形** | 整形 **6** 次，精确移除 **42,000** 字符 | 默认关闭；仅对输出密集型工具的重复内容生效，不可用时原样返回 |
| **⚡ System One 响应** | 累计决策 **125** 次（缓存命中 **12**），平均延迟 **142ms**，错误 **3** | 输入 **180.0KB**，按 $0.042/M 输入计约 **$0.0076**（输出免费） |

> 💡 **累计可测收益**：工具 Schema 精确移除字符数可核对；死循环与安全拦截只报计数，不做不可测的 token 折算。
```

### 2. HTTP / RPC 查询接口
若环境启用了 `webServer`（如 Web 或 Desktop profile），访问对应端口的 `/dsh-jev/stats` 路由：
- 浏览器访问直接展示格式化仪表盘（HTML）。
- `curl` 或程序请求（`Accept: application/json`）返回结构化指标 JSON。

### 3. 本地持久化与重置
- 所有指标跨会话持久化存储于 `~/.dsh/jev-stats.json`。
- 如需重置归零，可在调用工具时传入 `{ "reset": true }`，或删除该 JSON 文件。

---

## 许可证

[MIT](LICENSE)
