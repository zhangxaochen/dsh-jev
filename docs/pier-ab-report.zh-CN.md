# JEV 插件有效性 A/B 对照（中文版）

English version: [`pier-ab-report.md`](pier-ab-report.md)

复现工具与逐次证据: [`bench/pier-pilot/`](../bench/pier-pilot/README.md)

# JEV 插件有效性 A/B 对照（DeepSWE top20，CommandCode `deepseek/deepseek-v4.1-flash`）

停跑时间：2026-09-21 06:55（周额度 33.47/35 已用尽，见文末额度）。
产物与脚本：本目录；抢救产物 `salvage/`。

## 一、口径

| 项 | 定义 |
|---|---|
| 判分 | Pier verifier：`reward=1` ⟺ 全部 **F2P（FAIL_TO_PASS）** 通过且 **P2P（PASS_TO_PASS）** 无回归 |
| 连续分 | **F2P 通过率**（`f2p_passed/f2p_total`）—— 二元 reward 无法区分"差 1 个"和"差 41 个" |
| 臂 A / 臂 B | 同一模型同一任务，B 额外加载本插件（profile `headless-jev`） |
| 环境 | 同任务镜像、同并发、同起点（跨进程启动锁 5 s，构建错开 90 s） |

## 二、结果：17/20 完成

**3 胜 · 0 负 · 14 平**（其中 2 对无效，见第三节 ⇒ 有效 15 对：**3 胜 · 0 负 · 12 平**），partial 均差 **+0.309pp**。

三处差异全部为插件臂更好，且都在 F2P 通过率上：

| 任务 | A 对照 | B 插件 | Δ | 性质 |
|---|---|---|---|---|
| koota-composite-trait-aspects | 48/51（reward 0） | **51/51（reward 1）** | **+1.345pp** | **真翻盘**：B 做对、A 未做对 |
| koota-deferred-mutation-buffer | 65/71 | **69/71** | **+2.010pp** | B 少错 4 个测试 |
| koota-pair-relation-tracking | 33/38 | **37/38** | **+1.905pp** | B 少错 4 个测试 |

其余 12 对完全持平，其中 8 对两臂都 100%/100%（饱和任务，不存在可动空间）：
valibot · koota-query · fastapi-implicit · etree · scriggo · fastapi-deprecation · arcane · dynamodb · kysely · vitest。

## 三、必须剔除的 2 对（环境坏掉，不是测量）

| 任务 | A | B | 为什么无效 |
|---|---|---|---|
| narwhals-rolling-window-suite | F2P 0/103 · **P2P 0/10093** | 同 | P2P 归零说明**测试套件根本没跑起来** |
| kombu-virtual-queue-dead-lettering | F2P 0/76 · **P2P 0/1412** | 同 | 同上 |

## 四、单次方差：本实验最大的敌人

同一任务、同一臂、重复运行会给出差别巨大的结果：

| 观察 | 数据 |
|---|---|
| koota-deferred 插件臂（先 vs 后） | **30/71 → 69/71**（同一配置 ✗） |
| koota-deferred 对照臂（先 vs 后） | **70/71 → 65/71** |
| fastapi-deprecation 插件臂（先 vs 后） | **132/137 → 137/137**（先前记的"败局"消失） |
| koota-pair 对照臂 | **37/38 → 33/38** |

⇒ 单次对比的波动幅度（±56pp）**远大于**双臂之间的真实差异（±2pp）。因此：
**"koota-deferred 大滑坡是插件害的"这一读法已被重复实验证伪**，那是跑动方差。

## 五、结论

1. **分数通道**：17 对中插件臂 **0 负、3 正**，方向一致但幅度小（+1.3～+2.0pp）；受方差限制，只能说**"未检出损害，且有三处轻微优势"**，不能说已证明有优势。
2. **成本通道（14 对配对测量）**：prompt 总量中位 −3.2%，未缓存输入中位 **+16.6%**，步数中位 **+2.6%**，墙钟中位 **−12.5%**。按每步归一后上下文中位数 ≈ 0 ⇒ **token 上没有净收益**：剪枝确实裁掉了内容（单次 ≈2,200 条 / 857K token），但被插件自身注入与咨询调用抵消。
3. **工程有效性（非分数收益）**：剪枝活跃、循环护栏 0 误伤、安全护栏 6 万+ 次筛查 0 误拒，`headlessAsk=warn` 降级实测生效（`warned` 计数 > 0）。

## 六、未完成与后续

未测 3 个：`numba-stencil-boundary-modes`（试验反复报错，已列入 `skip.txt`）、`updo-policy-alerting`、`prometheus-transactional-reload-status`。

**额度**：周窗口 33.47/35（仅剩 1.53），重置 **2026-09-25 16:51**；月额度余 36.53。跑完剩余 3 个任务约需 $3–4，须等周重置或购买额度。

## 七、这轮踩到的坑（都已修）

1. Pier 用 `buildx --pull` 建镜像 ⇒ 本地预拉无用，必须"单拉 + 退避重试"。
2. **Docker 网络池耗尽**（`all predefined address pools have been fully subnetted`）⇒ 每次启动前 `docker network prune -f`；这是后期大面积失败的真正主因，不是 ECR。
3. Pier 的 job 目录按秒命名 ⇒ 双臂同秒启动会撞名，需要跨进程启动锁。
4. **后台作业会随会话边界被清空** ⇒ 长跑必须用脱离会话的独立进程（`Start-Process`），否则驱动器与 pier 被杀、容器变孤儿（本轮因此损失 10 个已跑完的试验，补丁已抢救）。
5. `reward=-1` 是试验自身报错，不是得分 0；判分字段是 `f2p_passed/f2p_total`，不是列表。

