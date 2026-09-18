# Changelog

本文件记录 dsh-jev 的行为变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-09-18

第一个经过标定的版本。0.1.0 的阈值是猜测值，且部分失败模式与宣称相反。

### Added

- **Agent 决策原语**：`jev_ask`（一次请求批量提问 noul/choice/score）、`jev_rank`（按准则排序候选）、
  `jev_check`（验证断言，区分成立/不成立/无法判定）。
- **语义 skill 路由** `skill-router`：目录达阈值时为当前请求指出一个最该载入的 skill，作为建议注入；
  目录过小、请求过短、请求与上轮相同、低于分/置信度阈值时都不发起调用。
- **语义结果整形** `result-shaper`（默认关闭）：对超长且明显重复的命令输出保留有信息量的中段；
  仅输出密集型工具、每轮限次、失败结果与下游改写不覆盖、任何异常返回原文。
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

### Removed

- `loopGuard.stuckSeverityThreshold`（语义已被 `pLoopThreshold` + `minConfidence` 取代）。

### Fixed

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


