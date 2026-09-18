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

## 安装与挂载

### 方式 1：DSH 官方命令行一键安装（推荐，自动激活为 Bundle）

DSH 原生支持 Bundle 机制，执行以下命令会自动安装依赖并激活该插件层：

```bash
dsh plugin --profile <profile_name> add dsh-jev
```

例如为 `headless`、`web` 或 `desktop` 激活：
```bash
dsh plugin --profile headless add dsh-jev
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
          stuckSeverityThreshold: 2
        safetyGuard:
          blockThreshold: 0.85
          askApprovalThreshold: 0.5
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
import * as TypeSafeClient from 'dsh-plugin-typesafe/client'
import * as LoopGuard from 'dsh-plugin-typesafe/loop-guard'
import * as SafetyGuard from 'dsh-plugin-typesafe/safety-guard'

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
- `triggerThreshold?: number`: 触发语义评估的连续动作最小步数（默认 `2`）。
- `noProgressThreshold?: number`: 认定为“缺乏进展”的置信度阈值，范围 0~1（默认 `0.3`）。
- `stuckSeverityThreshold?: number`: 卡死严重度打分阈值，范围 1~3（默认 `2`）。
- `include?: string[]`: 跟踪的特定工具列表（为空则跟踪所有）。
- `exclude?: string[]`: 忽略的工具列表。

### `SafetyGuardConfig`
- `blockThreshold?: number`: 阻断执行（返回 `deny`）的危害概率阈值（默认 `0.7`）。
- `askApprovalThreshold?: number`: 请求人工审批（返回 `ask`）的风险概率阈值（默认 `0.4`）。
- `guardedTools?: string[]`: 受到审查保护的高危工具列表（默认包含 `bash`, `run_command`, `run_code`, `write_to_file`, `replace_file_content`）。

### `ToolPrunerConfig`
- `maxTools?: number`: 上下文中最多保留的动态工具数量（默认 `5`）。
- `minScoreThreshold?: number`: 工具入选的最低相关性打分（1~3 分制，默认 `2`）。
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

## 许可证

[MIT](LICENSE)
