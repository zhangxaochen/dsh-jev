# dsh-jev

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

---

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
  blockThreshold: 0.7
})
```

---

## 配置参考

### `TypeSafeClientConfig`
- `apiKey?: string`: TypeSafe API Key（默认优先读取环境变量 `TYPESAFE_API_KEY`）。
- `baseUrl?: string`: API 地址（默认 `https://api.typesafe.ai/v1/systemone`）。
- `model?: string`: 决策模型（默认 `jev-latest`）。
- `timeoutMs?: number`: 超时时间，单位毫秒（默认 `10000`）。
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
- `guardedTools?: string[]`: 受到审查保护的高危工具列表（默认包含 `bash`, `run_command`, `run_code`, `write_to_file`, `replace_file_content`）。

### `ToolPrunerConfig`
- `maxTools?: number`: 上下文中最多保留的动态工具数量（默认 `8`）。
- `minScoreThreshold?: number`: 工具入选的最低相关性打分；实测刻度为 `[0, 2]`（3 级 rubric，默认 `2`）。
- `alwaysRetain?: string[]`: 永远不被剪枝保留的核心工具（默认包含 `read_file`, `write_to_file`, `bash`, `run_command`）。

---

## 本地开发与测试

本项目采用 Node.js 原生测试运行器，测试执行速度极快（< 300ms），且不依赖外部网络与 API Key（内置 Mock 测试套件）：

```bash
# 编译 TypeScript
pnpm run build

# 运行自动化单元测试
pnpm test
```

---

## 📊 指标统计与用户收益感知

`dsh-jev` 内置了完整的指标收集与收益感知系统，自动追踪工具剪枝节省的 Schema Token、死循环熔断止损、安全门禁拦截次数以及 System One 决策延迟：

### 1. Agent 工具直接调取看板
在对话中直接让模型执行 `jev_stats`，或通过命令调取，即可输出结构化看板卡片：
```markdown
### 🛡️ TypeSafe Jev 守护与收益看板

| 守护维度 | 核心拦截/优化战果 | 预估 Token / 成本收益 |
| :--- | :--- | :--- |
| **🛠️ 工具动态剪枝** | 评估 **42** 次，裁剪 **210** 个次无关工具 | 净省约 **31.5K** Tokens (Prompt Schema 压缩) |
| **🔄 死循环及早止损** | 检查 **18** 次，阻断 **2** 次死循环，警示 **3** 次 | 止损节省约 **30.0K** Tokens (避免无效空转) |
| **🔒 执行安全护栏** | 审查 **65** 次敏感指令，阻断 **1** 次高危操作 | 拦截敏感破坏性命令 / 降级审批 **4** 次 |
| **⚡ System One 响应** | 累计决策 **125** 次，平均延迟 **142ms** | 毫秒级快速裁决，保障会话低延迟零卡顿 |

> 💡 **累计总收益**：累计预估为当前工作区节省 **~61.5K** 运行 Token 开销。
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
