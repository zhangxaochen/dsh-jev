# Changelog

本文件记录 dsh-jev 的行为变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **社区扫描入库**：`docs/community-scan-2026-09-19.md`（带日期的快照），`docs/research.md` 补齐三行"确实借鉴"的对照，并把 5 项主动不做的实践连同**重开条件**写入未采纳表——"未采纳"与"没想到"在文档里不再长得一样。
- **每次判定成本口径**：看板新增一行（累计 `$`/次、只看计费调用的 `$`/次、缓存命中率），`getSnapshot()` 派生 `costPerDecisionUsd` / `costPerBilledCallUsd` / `cacheHitRate`——**只在读取时计算、不落盘**（持久化的派生值会随计数漂移，而 `normalizeMetrics` 的类型检查挡不住漂移）；README 门面把 "effectively free" 换成实测数字（每次判定 ≈ $0.00013，2026-09-20 实测 2,254 次判定）。

## [0.2.0] - 2026-09-18

第一个经过标定的版本。0.1.0 的阈值是猜测值，且部分失败模式与宣称相反。

### Added

- **Agent 决策原语**：`jev_ask`（一次请求批量提问 noul/choice/score）、`jev_rank`（按准则排序候选）、
  `jev_check`（验证断言，区分成立/不成立/无法判定）。
- **语义 skill 路由** `skill-router`：新增 `requestTimeoutMs`（默认 4000ms）——实测 112 项目录的请求需 1.36–1.45s，沿用的 800ms 建议超时会让路由**每次都失败并被静默吞掉**；新增 `nameMatchBoost`（默认 0.6）——请求字面点名技能时加分，修复「写着 SWOT 却选中 company-intel」；新增可选 `maxCandidates`（默认 0 = 不裁剪，词法预筛对跨语言场景有风险）。同一意图只建议一次；每轮装配最多一条同名条目；目录过小、请求过短、低于阈值或目录读取失败时保持沉默）：目录达阈值时为当前请求指出一个最该载入的 skill，作为建议注入；
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
- **状态栏总开关**：输入框下方状态栏（`conversation.input.right` 插槽）新增 `jev` 开关（switcher：开=**绿轨道**+白色滑块在右，关=中性轨道+滑块在左，读不到状态=虚线禁用），点一下即切换插件是否生效，**无需卸载、无需重启**——各模块在每次决策前读取开关，状态立即生效。配色用宿主语义 token（开=`--dsw-alias-state-success-primary`、关=`--dsw-alias-fill-l2`，滑块固定白+阴影），并支持 `focus-visible` 焦点环与 `prefers-reduced-motion`。持久化在 `~/.dsh/jev-enabled.json`；也可用 `POST /api/dsh-jev/stats {"enabled":false}`，或查询参数 `?enabled=0` / `?enabled=1`（该 webServer 路由不解析 body，故提供 query 形式，方便 curl）。**停用是彻底的**：连确定性硬拒层（无需模型调用的那一层，例如递归删除根目录）也一并停止拦截——总开关里留隐藏例外会造成「开关显示为关却仍被拦」的困惑，故不设例外，README 在开关说明旁明确标注。开关文件缺失、损坏或不可读时**一律视为启用**：文件系统故障不该悄悄关掉护栏。
- **开关的滑块颜色用错 token（0.2.0 内修复）**：滑块原本取 `--dsw-alias-label-*`（**文字**色），在浅色语境下渲染成近黑 ✗，与「滑块应为 on-color/固定亮色」（iOS、Material 的做法）相反；开启态轨道也用了手挑的 `#16a34a`（green-600）而偏暗 ✗。现改为：开启态轨道用宿主的 `--dsw-alias-state-success-primary`（= `--dsw-static-green-500`，随主题走）、滑块固定 `#ffffff` 加 `0 1px 2px` 阴影、关闭态轨道用中性表面 token ✓

### Changed
- **headless 下 `ask` 默认放行并告警（`headlessAsk: warn`）**：`ask` 的本意是「该由人决定」，而无法弹窗的会话把它变成拒绝 ✗ —— 实测两次 hazard 0.50 / 0.72 的询问被硬拒后，agent 步数 +12% ✓。要恢复旧的 fail-closed 设 `headlessAsk: 'deny'` ✓。**硬拒区间（≥ `blockThreshold`）与确定性外壳不变** ✓；新增 `safetyGuard.warned` 计数 ✓。
- **拒绝与告警的决策日志现在带脱敏命令摘要** ✓（截断 160 字符，抹掉 `sk-…` / `Bearer …` / `token=` / `password=` 一类 ✓）：此前日志只记概率 ✗，两次拒绝事后**无法审计** ✓；`commandPreview()` 优先展示命令字段本身而不是 JSON ✓。

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
- **指标文件可被环境变量重定向**：`DSH_JEV_METRICS_PATH` 覆盖落盘路径，且路径改为**首次使用时**解析。
  此前任何导入插件的脚本都会在导入瞬间以自身 schema 覆写 `~/.dsh/jev-stats.json`——那正是 `pnpm run doctor`
  用来判断「宿主是否已重载新构建」的信号，于是验证脚本会把部署结论改写成假象。所有验证脚本
  （`verify:dsh` / `verify:live` / `verify:tools` / `bench`）现已指向临时文件。

- **`safetyGuard.onError` 默认改为 `allow`（语义裁决拿不到时放行）**：原默认 `deny-guarded` 把**运行期依赖**当成了安全性判据——判定服务一抖，宿主所有受保护工具（含 shell）全被拒。实机观测：约 **2%** 调用被拒、并出现「失败一次 + 退避 + 重试成功」合计 **4822ms** 的一次；诊断数据是成功检查耗时 1.2–1.4s 而旧预算 800ms。新默认下**唯一改变的是这一条路径**：确定性外壳在任何策略下都照旧拒绝（例如递归删除根目录**不需要模型调用**），裁决到达时危险判定照旧生效，失败会计入 `inspectionFailures` 并告警、上墙，而不是静默放行。`onUncertain`（判定到达但无可用概率）**保持 fail-closed**：那里模型答了，只是答得不可用，且实机从未发生（`uncertainDenied` 为 0）。若你的威胁模型认为「判定服务不可达本身就是攻击面」，在自有补丁层钉 `onError: deny-guarded` —— README 在默认值旁写明了这一点。

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

- `loopGuard.cooldownSteps` 实际只静默 **N−1** 步：冷却计数在判断之前先减量，因此配置 3 只有 2 步静默。改为先读状态再减量（每步仍计时），故 `N` 现在名副其实——与 README 的「Steps to stay silent after an intervention」一致。

- **`jev_stats` 工具的输出超出自身 schema（0.2.0 内修复）**：schema 声明 `additionalProperties: false` 且只列 `markdown`/`tokensSaved`，而 `execute` 又多返回一个 `bench` 字段——在会校验工具输出的宿主上**每次调用都会失败**。该字段无人使用（基准行已在 markdown 内，HTTP 路由负载另有 `bench` 供面板使用），故移除。
- **服务解析不回退（0.2.0 内修复）**：`tools`/`connection`/`webServer` 三处此前按「`ctx.get` 是否存在」二选一——一旦宿主提供 `get` 而对未声明 `inject` 的服务返回 `undefined`，插件就**静默什么都不挂载**。改为先 `get`、失败再回退到同名属性。
- **安全检查的超时预算过紧，导致「延迟抖动 → 受保护工具全被封」（0.2.0 内修复）**：`safety-guard` 的语义审查此前沿用 `client.pathTimeoutMs`（800ms）——那是**建议路径**（失败放行无代价）的预算，而这条路径**失败即拒绝**。实测冷调用 700–750ms、宿主重启后 16 次成功审查耗时 **587–777ms**，即预算就压在实测天花板上；一次抖动后检查连续失败，`onError: deny-guarded` 便把**所有**受保护工具（含 `pwsh`）拒之门外。现改为独立配置 `safetyGuard.inspectionTimeoutMs`（默认 **3500ms**，约为最慢实测值的 4.5 倍），并对**瞬时**失败（超时/中断/429/5xx）**有界重试一次**（`inspectionRetries`，默认 1），仍失败才套用 `onError`；「裁决不可用」不走重试，仍归 `onUncertain`。重试与最终失败次数计入看板，供后续用数据校准预算。同类问题在 `skillRouter` 上已发生过一次（800ms 致 7/7 线上用例中止，后给它单独的 4000ms）。

- **后续版本新增的指标字段在既有文件上不会被补齐（0.2.0 内修复）**：`MetricsCollector.loadInitial()` 对已存在的 v2 文件直接返回解析结果，于是**该构建期望、而文件里没有的字段保持 `undefined`**——看板会显示 `undefined`，而**首次自增会写入 `NaN` 并持久化**，此后每次重启都带着它。实机复现：为校准检查预算新增的两个计数上线后未出现在实机文件中（文件只有旧 5 个 `safetyGuard` 字段）。这不是个别字段的问题，而是**任何后续新增指标都会踩**的结构性缺口：现改为加载时用 `normalizeMetrics()` 把已存快照**逐键、逐段**合并到新默认值之上（存值保留、缺字段回填、整段缺失也回填）。
- **确定性外壳把「提及」当成「执行」（0.2.0 内修复）**：`looksLikeRootDelete` 原本在命令文本里**任意位置**寻找删除动词，于是**提交信息、grep 模式、echo 字符串里引用**该命令都会被硬拒——实测就是这样拦掉了一次合法提交 ✗。现要求动词处于**命令位**：动词之前的词必须是前缀词（`sudo`/`xargs`/`env`/`exec`…）、旗标、`VAR=value`，或前一个旗标的取值（`sudo -u root`），否则判定为「提及」而不拦 ✓；分段改为**引号感知**（信息里的 `&&` 不再被切成两条命令），并处理**转义引号**（参数经 `JSON.stringify` 会再引一次，不处理会判错引号状态）。壳包装器的**载荷**仍按独立命令解析，`bash -c "…"`、`sudo -u root bash -c "…"`、`pwsh -Command "…"` 照旧拒绝。语料 92 → 100 例（61 拒 / 39 放行）。**已知局限**：另一批词法 `HARD_DENY_RULES`（Windows 形态）对「提及」仍会误拒，未改并已在 `docs/calibration.md` §23.9 记录。


- **确定性外壳把「序列化参数」当成命令来判（0.2.0 内修复）**：`inspectableText()` 会把 `JSON.stringify(args)` 与命令行文本**一并**送入 `HARD_DENY_RULES` 的词法正则 ✗，而那些正则用**无界间隔**（`[^\n]*`）连接「动词 → 递归旗标 → 强制旗标 → 盘符」⇒ 序列化后整个多行脚本压成一行 ✗，正则的盘符 `[a-z]:` 匹配到了 JSON **键名** `"command":` 里的 `d":` ✓ 于是「递归强制删除盘根」成立 ✗ —— 实测把一个「删除两个具体路径」的合法脚本拒掉了 ✗。现改为**已找到命令行文本时不再检查序列化形式**（该兜底只服务于「命令藏在未知键下」的形状，此时本就该跑 ✓）；语料 100 → **103 例（63 拒 / 40 放行）**。

### Notes

- 升级到 0.2.0 需检查的三处破坏性变更见本文件 0.2.0 的 `Changed` 小节（`stuckSeverityThreshold` 移除、受保护工具的失败策略、指标 schema 升至 v2）；README 不再重复维护一份，它只链接到这里。
- 同步文件后**必须重启 DSH**：本部署的 profile 组合未挂载 HMR，运行中的进程不会重新加载模块。
  用 `pnpm run doctor` 判定是否已生效。

## [0.1.0] - 2026-09-18

首个版本：TypeSafe client、死循环守卫、执行安全门禁、动态工具剪枝与指标看板。
阈值未经标定，失败策略为「出错即放行」。


