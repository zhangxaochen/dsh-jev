# dsh-jev

[![CI](https://github.com/zhangxaochen/dsh-jev/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangxaochen/dsh-jev/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-jev.svg)](https://www.npmjs.com/package/dsh-jev)

[English](https://github.com/zhangxaochen/dsh-jev/blob/master/README.md) · **简体中文**

> **0.2.0 现状：测到了什么、没测到什么。**
> 仓库全部闸门为绿（`pnpm test`、`verify:mutants`、`drill`、`verify:build`、`verify:solo`），每个插件面都有实时计数：剪枝在移除工具结果、循环护栏不误打断、安全护栏筛查数千次动作且无误拒；0.2.0 起 `headlessAsk` 默认 `warn`，headless 会话改为留痕放行而不是 fail-closed 拒绝。
> **尚未证明的是：这些能否改善结果。** 在 20 个真实 DeepSWE 任务上做的 A/B 对照（开/关本插件，同模型同镜像）**既未检出优势，也未检出稳定损害** —— 按每臂均值：2 胜 · 2 负 · 13 平，F2P 均值差 −1.10pp。成本上**没有净 token 节省**（prompt 中位 −3.2%、未缓存输入 +16.6%、步数 +2.6%），墙钟只有微弱且符号不一的改善（中位 −12.5%）。同一臂内的跑动离散度可达 55pp，大于任何被测效应；且 20 个任务里有 8 个是饱和任务（两臂都 100%），这组任务本身的检出功效就很有限。
> 因此请把这一语义层理解为**快、便宜、功能可用 —— 端到端收益尚未证实**。完整报告与逐次证据：[`docs/pier-ab-report.zh-CN.md`](docs/pier-ab-report.zh-CN.md) · [English](docs/pier-ab-report.md) · 复现工具在 [`bench/pier-pilot/`](bench/pier-pilot/README.md)。

Jev（TypeSafe System One 决策模型）与 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的官方 Cordis 插件组合包。

它补上 dsh 自己没有的那一层语义判断：引入 ~150ms 极低延迟的非生成式决策原语（Noul、Choice、Score），做**动态工具剪枝**（省 Prompt Token、降首字延迟）、**语义死循环阻断**与**高危执行安全门禁**。判定走 System One 而非生成式采样，所以快、可复现，且成本可忽略：**每次判定 ≈ $0.00013**（2026-09-20 实测 2,254 次判决，每次输入 12.4KiB，按 $0.042/M 输入 token 计费、输出免费）。

## 目录

- [到底有没有用？A/B 证据与复现工具](docs/pier-ab-report.zh-CN.md)
- [特性](#特性)
- [安装](#安装)
- [使用](#使用)
- [与 DSH 内置能力的分工](#与-dsh-内置能力的分工)
- [开发与验证](#开发与验证)
- [贡献](#贡献)
- [许可证](#许可证)

## 特性

| 模块 | 切入的服务 / 钩子 | 作用 |
| :--- | :--- | :--- |
| `typesafe-client` | 注册 `ctx.typesafe` | 封装 System One API：多问题单次并发评估、超时重试、测试 Mock。 |
| `typesafe-loop-guard` | `tools/post-execute` | 语义判断每步是否真有解题增量，拦截死循环并在 `additionalContexts` 注入纠偏提示（参数哈希去重做不到的近似停滞）。 |
| `typesafe-safety-guard` | `tools/pre-execute` | 毫秒级审查 Shell / 文件操作中的高危行为（`rm -rf`、提权、凭据泄露），阻断（`deny`）或要审批（`ask`）。 |
| `typesafe-tool-pruner` | `ctx.toolPruner` | 工具多到几十上百个时，按意图只注入最相关的 Top-K，砍掉大块工具 Schema。 |
| `jev_ask` / `jev_rank` / `jev_check` | Agent 工具 | 把决策原语交给模型自己：批量提问、按准则排序、验证断言（成立 / 不成立 / 无法判定）。 |
| `typesafe-skill-router` | `system-prompt/assemble` | 技能目录够大时指出**一个**最该载入的 skill，作为建议注入（不阻断、不删减）。 |
| `typesafe-result-shaper` | `tools/post-execute`（**默认关闭**） | 超长且重复的命令输出只留有信息量的中段，其余丢弃。 |

`pnpm run verify:turn` 一整轮（全部模块 + 真实模型 + 真实装配）的实测输出：

```
assemble:       2139ms -> 12 tools to 5 (edit_file,git_commit,git_push,read_file,run_tests)
skill intent:   把这份用户调研整理成一份 PRD 文档 -> 1 advice in 979ms
post-execute:   586ms -> 32680 to 237 chars
semantic overhead this turn: 3704ms
```

`verify:live` 中真循环 `pLoop=0.88`、置信度 `0.81` 命中，健康轨迹 `pLoop=0.00` 不触发。数值随请求与输出规模变化，阈值来源与完整标定见 [`docs/calibration.md`](docs/calibration.md)。

## 安装

**要求**：Node `^22.19.0 || >=24.0.0`；DSH `>=0.1.5-rc.2`。插件挂载 `tools.guard()`、`tools/pre-execute`、`tools/post-execute`、`system-prompt/assemble`、`agent/pre-step`，并按需读取 `tokenMeter` / `skills` / `toolResultPruner` 服务——缺失时按降级路径工作。

```bash
# 从 GitHub 直装（免发包，即装即用，拿到的就是当前代码）
dsh plugin --profile <profile_name> add github:zhangxaochen/dsh-jev

# 或从 npm 装（>= 0.2.0 才有文件写入门禁）；也适用于 headless / web 等具体 profile
dsh plugin --profile headless add dsh-jev
```

> ⚠️ **`desktop` profile 不能这样装**。CLI 会直接拒绝：
> `error: profile "desktop" is managed exclusively by the Electron application`。
> 桌面端请通过应用内的插件入口安装，或按「开发与验证」一节把包同步到
> `~/.dsh/profiles/desktop/node_modules/dsh-jev`（`pnpm run sync` 就是这么做的）。
>
> `dsh plugin` 本身不含子命令，它把**参数转发给该 profile 目录下的 pnpm**（实测报错信息：
> `plugin needs pnpm arguments to forward (e.g. add <package>)`），因此 `add` / `remove` / `list`
> 都是 pnpm 的语义。

## 使用

**API Key** 写进 `$DSH_HOME/.env`（默认 `~/.dsh/.env`，桌面端与所有 CLI profile 启动时都会自动载入），或设同名环境变量；未配置时 DSH 不会崩溃，插件记 Warn 并按 Mock 模式运行，只是无法发起云端仲裁。

```bash
TYPESAFE_API_KEY=your_typesafe_api_key_here
```

装完即用，默认值都已标定，**不改配置就能跑**：

- **状态栏开关**：输入框下方的 `jev` switcher，点一下即启用/停用全部模块，无需卸载或重启（停用语义见配置手册）。
- **决策原语**注册为 Agent 工具，模型可自行调用 `jev_ask` / `jev_rank` / `jev_check`。
- **看板**：让 Agent 执行 `jev_stats`，或请求 `GET /api/dsh-jev/stats`（浏览器得到 HTML 仪表盘，`Accept: application/json` 得到 JSON）。指标持久化在 `~/.dsh/jev-stats.json`。

要改阈值、写自定义安全规则、嵌入非 DSH 的 Cordis 宿主，见 [`docs/configuration.md`](docs/configuration.md)（含全部字段的默认值与理由）。

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

## 开发与验证

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

其余闸门——`probe` / `verify:tools` / `verify:pruner` / `verify:router` / `verify:shaper` / `verify:turn` / `verify:pack` / `verify:mutants` / `verify:solo` / `drill` / `bench` / 覆盖率审计——的命令与各自证据见 [`docs/verification-report.md`](docs/verification-report.md)；借鉴项与其证据见 [`docs/research.md`](docs/research.md)；行为变更史与**升级步骤**见 [`CHANGELOG.md`](CHANGELOG.md)（破坏性变更只写在那里，README 不重复）。

CI（`.github/workflows/ci.yml`）在 Node 22 与 24 上跑 `build → typecheck:scripts → test → bench:offline → verify:dsh（跳过）→ 打包校验`：基准是离线回放的且带**输入指纹校验**，因此不需要 API Key；**任何未标记为已知漏报的用例行为不符都会让 CI 失败**。

### 改完怎么让本机生效

profile 里的插件是**构建产物的副本**，改完源码必须同步，然后重启 DSH：

```bash
pnpm run sync              # 同步到所有已安装该插件的 profile（自动发现）
pnpm run sync:desktop      # 只同步 desktop
pnpm run doctor            # 逐 profile 比对构建哈希、安装版本与指标 schema，输出 ACTION: 或 OK:
```

`pnpm run sync` 同时把 profile 清单里声明的 `dsh-jev` 版本对齐到本仓库版本：声明是精确版本而安装副本是**原地替换**的，两者漂移后该 profile 里任何一次 `pnpm install`（`dsh plugin add` 都会跑）会把新版本**静默换回**声明版本；`doctor` 会报出这类漂移（`declaredMatch`）。验证脚本不会污染实机指标——`verify:*` / `bench` 都把指标与决策日志写到 `%TEMP%`（`DSH_JEV_METRICS_PATH` / `DSH_JEV_DECISIONS_PATH`），否则 `~/.dsh/jev-stats.json` 会被测试覆写，而那正是 `doctor` 判断部署状态的依据。

> ⚠️ **必须重启 DSH**：本部署的 profile 组合里没有挂载 HMR 插件，运行中的进程不会重新加载 `node_modules` 下的模块。只同步不重启，会话里跑的还是旧构建（`doctor` 会明确报 `ACTION: restart DSH`）。

## 贡献

Issue 与 PR 都欢迎。改动要满足：

- `pnpm test` 全绿（含 `verify:solo` 的顺序无关检查与 `verify:mutants` 的变异扫描）。
- 行为变更同步 [`CHANGELOG.md`](CHANGELOG.md)；新增闸门同步 [`docs/verification-report.md`](docs/verification-report.md) 的证据表（证据表必须列出每个 `verify:*` 脚本，有测试守着）。
- 配置字段增删时 [`docs/configuration.md`](docs/configuration.md) 要同步（字段是否被文档覆盖同样有测试守着）。
- 发版只推一个 tag，流程与一次性 npm 配置见 [`docs/releasing.md`](docs/releasing.md)。

维护者：[@zhangxaochen](https://github.com/zhangxaochen)

## 许可证

[MIT](LICENSE)
