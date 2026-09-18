# Changelog

本文件记录 dsh-jev 的行为变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-09-18

第一个经过标定的版本。0.1.0 的阈值是猜测值，且部分失败模式与宣称相反。

### Added

- **Agent 决策原语**：`jev_ask`（一次请求批量提问 noul/choice/score）、`jev_rank`（按准则排序候选）、
  `jev_check`（验证断言，区分成立/不成立/无法判定）。
- **语义 skill 路由** `skill-router`（同一意图只建议一次；每轮装配最多一条同名条目；目录过小、请求过短、低于阈值或目录读取失败时保持沉默）：目录达阈值时为当前请求指出一个最该载入的 skill，作为建议注入；
  目录过小、请求过短、请求与上轮相同、低于分/置信度阈值时都不发起调用。
- **语义结果整形** `result-shaper` 判定单元重写为「行形状聚类 + 每类一条代表行分类」：先把只差数字/哈希的行归为一类（600 行 → 数类），再对每类代表行做有界分类（`routine_progress`/`summary`/`warning`/`failure`），只留 `warning`/`failure`。此前按「块」逐块问「是否仍有信息」在本模型上不可靠（平坦分布或自信选错，实测见 calibration §9）；重写后 600 行只需 1–4 条问题，且对 600 行中的单行报错稳定给出 `failure`（置信度 1）。默认仍关闭：实测模型无法在构建日志上区分报错块与噪声块，故新增「分布不可分即拒绝」（`spreadThreshold`），并放宽廉价前置检查（体量与结构重复）、单列整形请求超时（`requestTimeoutMs` 4000ms）与每块预览长度（`blockPreviewChars` 600）：对超长且明显重复的命令输出保留有信息量的中段；
  仅输出密集型工具、每轮限次、失败结果与下游改写不覆盖、任何异常返回原文。
- **随包配置与库默认对齐**：`cordis.patch.yml` 的 `guardedTools` 此前只列 5 个 shell 工具，导致默认安装下**文件写入完全不受语义门禁**（与库默认及文档不符）；现补齐为 8 个，并加入回归测试，禁止发布配置把受保护清单或 always-retain 清单改小。
- **确定性安全外壳**：文件系统根删除、磁盘覆写、凭据外传、fork bomb 等形态经 `ctx.tools.guard()`
  同步拒止，0 次模型调用，且后续监听者无法强制放行。
- **用户自定义安全规则** `safetyGuard.rules`，与内置问题在同一次请求内评估。
- **凭据分类** `credential_kind`：区分真实凭据、私钥与占位/引用，避免把文档里的示例值判成高危。
- **决策日志** `~/.dsh/jev-decisions.jsonl`：每次判定（含 pass 的负样本）带置信度、延迟、输入字节数，
  供阈值复核；`DecisionLog.summarize()` 给出各模块置信度分布。
- **A/B 基准** `bench/`：30 条标注样本（15 loop + 15 safety）套用与插件逐字相同的规则，
  输出误报/漏报/准确率/延迟；`bench:offline` 回放录制答案，无需 Key、零成本。
- **部署自检** `pnpm run doctor`：逐 profile 比对构建哈希与版本，并读取运行中宿主写入的指标 schema 版本。
- **多 profile 同步** `pnpm run sync`：自动发现所有已安装该插件的 profile（旧脚本只同步 desktop）。
- 新增 `tests/probe.ts`、`tests/live-verify.ts`、`tests/live-tools.ts` 三个可复现的验证脚本。

### Changed

- **死循环判定改用「死循环桶概率 + 置信度」**，不再比较 `score` 刻度。修复前的反向三元阈值让配置值
  `2` 实际生效为 `1.4`，把「边缘重复」误判为死循环（已实测复现两次误报）。
- **受保护工具默认 fail-closed**：判定超时/报错/答案不含可用概率时拒绝执行，headless 下 `ask` → `deny`。
- `loopGuard`：按 agent 对象建立有界历史（`WeakMap` + `maxHistory`），新增 `cooldownSteps`、
  `deferExactRepeats`（精确重复交给 DSH 内置 `repeat-tool-reminder`），并监听 `agent/pre-step` 清链。
- `client`：`timeoutMs` 默认 10000 → 2000，新增 `pathTimeoutMs`（默认 800，用于后置建议路径）；
  相同载荷带指纹与 TTL 的缓存；缓存命中不计入延迟均值。
- **指标改为实测口径**：删除「每个被剪工具 150 token」「每次死循环 15000 token」两个凭空常量，
  改为精确移除字符数 + `ctx.tokenMeter.estimateMessage` 定价，并用 `tokenSource` 标明口径；
  死循环与安全拦截只报计数。指标文件 schema 升至 v2。
- 看板/`/api/dsh-jev/stats`/`jev_stats` 附最近一次基准摘要；未跑过时明确写「暂无记录」。
- **工具剪枝保持上游顺序**：此前返回 `[...alwaysRetain, ...按相关性排序的入选工具]`，既把保留工具提前，又让尾部随分数每轮漂移；现改为保持候选原序（只决定成员、不决定位置），避免模型可见前部内容变动导致 KV cache 前缀失效。
- 测试环境不再回退读取 `~/.dsh/.env`，离线测试因此真正离线（此前会静默打真实 API）。
- **测试套件与实机状态隔离**：`pnpm test` 会经 `defaultMetrics` / `defaultDecisionLog` 写入实机文件——
  足够让陈旧宿主看起来「已重载」（v2 指标被测试写到 `~/.dsh/jev-stats.json`），也足以把测试判决混进标定数据集。
  现由 `tests/isolate.mjs` 经 `node --import` 预载重定向到临时目录，并有单测守卫该预载不被移除。
- **决策日志同样可重定向**：`DSH_JEV_DECISIONS_PATH` 覆盖 `~/.dsh/jev-decisions.jsonl` 的位置，路径改为首次使用时解析。
  该文件是阈值复核所用的标定数据集，此前任何导入插件的脚本都会把自己的 mock 判决追加进去
  （实测一次集成校验追加 6 条），后续复核将读到植入的数据。
- **测试套件与实机状态隔离**：`pnpm test` 会经 `defaultMetrics` / `defaultDecisionLog` 写入实机文件——
  足够让陈旧宿主看起来「已重载」（v2 指标被测试写到 `~/.dsh/jev-stats.json`），也足以把测试判决混进标定数据集。
  现由 `tests/isolate.mjs` 经 `node --import` 预载重定向到临时目录，并有单测守卫该预载不被移除。
- **决策日志同样可重定向**：`DSH_JEV_DECISIONS_PATH` 覆盖 `~/.dsh/jev-decisions.jsonl` 的位置，路径改为首次使用时解析。
  该文件是阈值复核所用的标定数据集，此前任何导入插件的脚本都会把自己的 mock 判决追加进去
  （实测一次集成校验追加 6 条），后续复核将读到植入的数据。
- **指标文件可被环境变量重定向**：`DSH_JEV_METRICS_PATH` 覆盖落盘路径，且路径改为**首次使用时**解析。
  此前任何导入插件的脚本都会在导入瞬间以自身 schema 覆写 `~/.dsh/jev-stats.json`——那正是 `pnpm run doctor`
  用来判断「宿主是否已重载新构建」的信号，于是验证脚本会把部署结论改写成假象。所有验证脚本
  （`verify:dsh` / `verify:live` / `verify:tools` / `bench`）现已指向临时文件。

### Removed

- `loopGuard.stuckSeverityThreshold`（语义已被 `pLoopThreshold` + `minConfidence` 取代）。

### Fixed

- **`agent/pre-step` 监听说谎式返回（Phase 1 引入，0.2.0 内修复）**：该事件是 waterfall，监听器不调用 `next()`
  会返回 `undefined`，下游决策随之丢失，DSH 的 agent loop 会在 `decision.kind` 上抛错。`loop-guard`
  的清链与 `result-shaper` 的预算重置已改为委派——清链照旧执行，决策原样交还。
- `deterministicVerdict` 此前对 `rm -rf /`、`rm -rf ~` 等常见形态失效：模式以 `(?:\s|$)` 结尾，
  而参数经 JSON 序列化后命令尾部是引号。改为结构化解析删除命令的动词/开关/目标，并对多个候选串匹配。
- `normalizeAnswers` 不再把缺失或异形的答案强制成 `0`（那等于把「不知道」当成「安全」）。
- 各个守卫此前只看 `ctx.get('typesafe')`，忽略了 `provide` 不可用时注册的 `ctx.typesafe`，
  导致注入的 Mock/客户端被静默替换成未配置实例。

- `engines.dsh` 由 `>=0.1.0` 收紧为 `>=0.1.5-rc.2`：插件依赖的钩子与服务只在该版本上验证过，
  原先的声明会让不兼容宿主通过安装期检查。
- `bench --offline` 不再覆写 `~/.dsh/jev-bench.json`：离线回放没有延迟与费用可报，
  看板应保留最近一次真实 API 的实测数字。

### Notes

- 升级到 0.2.0 需检查的三处破坏性变更见 README「从 0.1.0 升级到 0.2.0」。
- 同步文件后**必须重启 DSH**：本部署的 profile 组合未挂载 HMR，运行中的进程不会重新加载模块。
  用 `pnpm run doctor` 判定是否已生效。

## [0.1.0] - 2026-09-18

首个版本：TypeSafe client、死循环守卫、执行安全门禁、动态工具剪枝与指标看板。
阈值未经标定，失败策略为「出错即放行」。


