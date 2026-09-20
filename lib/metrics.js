/**
 * Metrics tracking and telemetry for TypeSafe AI (dsh-jev).
 * Records tool pruning token savings, loop guard interruptions, safety screenings, and latency.
 * @module dsh-jev/metrics
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/**
 * Fallback characters-per-token used only when no token estimator is available.
 * The previous build multiplied a flat 150 tokens per pruned tool and claimed
 * 15000 tokens saved per interrupted loop; neither was measured, so both are gone.
 */
export const FALLBACK_CHARS_PER_TOKEN = 3.5;
function createEmptyMetrics() {
    const now = new Date().toISOString();
    return {
        version: 2,
        firstRecordedAt: now,
        lastUpdatedAt: now,
        toolPruner: {
            evaluations: 0,
            toolsPruned: 0,
            toolsRetained: 0,
            removedSchemaChars: 0,
            estimatedTokensSaved: 0,
            tokenSource: 'heuristic',
        },
        loopGuard: {
            checks: 0,
            interrupted: 0,
            warned: 0,
            notices: 0,
            uncertain: 0,
        },
        safetyGuard: {
            screened: 0,
            blocked: 0,
            approvals: 0,
            warned: 0,
            hardDenied: 0,
            uncertainDenied: 0,
            inspectionRetries: 0,
            inspectionFailures: 0,
        },
        resultShaper: {
            shaped: 0,
            charsRemoved: 0,
        },
        systemOne: {
            totalCalls: 0,
            totalLatencyMs: 0,
            avgLatencyMs: 0,
            errors: 0,
            latencySamples: 0,
            inputBytes: 0,
            estimatedCostUsd: 0,
            cacheHits: 0,
            decisionErrors: 0,
        },
    };
}
/** Environment override for the metrics file, used by verification scripts. */
export const METRICS_PATH_ENV = 'DSH_JEV_METRICS_PATH';
/**
 * Where the collector persists, resolved on first use rather than at import.
 *
 * A script that merely imports the plugins would otherwise construct the
 * collector against the live file and overwrite the very metrics an operator
 * reads to judge a deployment. Resolving late lets a tool point the collector at
 * a scratch file after imports and before its first decision.
 */
export function resolveMetricsPath(explicit) {
    if (explicit !== undefined && explicit.length > 0)
        return explicit;
    const override = typeof process !== 'undefined' ? process.env?.[METRICS_PATH_ENV] : undefined;
    if (override !== undefined && override.length > 0)
        return override;
    return join(homedir(), '.dsh', 'jev-stats.json');
}
/**
 * Merge a persisted snapshot over a fresh default, key by key and section by section.
 *
 * A field added in a later build is absent from files written before it, and returning
 * the stored object verbatim leaves it `undefined`: the dashboard renders "undefined" and
 * the first increment writes `NaN` into the persisted file, which then survives every
 * restart. Observed live - the live file carried the five 0.2.0 safety fields but not the
 * two added with the inspection budget. Merging keeps every stored value and backfills
 * whatever this build expects.
 */
export function normalizeMetrics(stored) {
    const defaults = createEmptyMetrics();
    if (!stored || typeof stored !== 'object')
        return defaults;
    const record = stored;
    const merged = { ...defaults };
    /**
     * Take the stored value only when it can be the same kind of thing as the default.
     *
     * A counter polluted by a persisted `NaN` arrives as `null`, and `null + 1` is 1 while
     * `null` itself is not a count - so a stored value whose type contradicts the default is
     * treated as missing and the default repairs it. Keys the defaults do not know are kept
     * as they are rather than dropped.
     */
    const pick = (fallback, value) => {
        if (isPlainObject(fallback) && isPlainObject(value)) {
            const section = { ...fallback };
            for (const [inner, innerValue] of Object.entries(value)) {
                section[inner] = pick(section[inner], innerValue);
            }
            return section;
        }
        if (fallback === undefined)
            return value;
        if (value === undefined)
            return fallback;
        return typeof value === typeof fallback ? value : fallback;
    };
    for (const [key, value] of Object.entries(record)) {
        merged[key] = pick(defaults[key], value);
    }
    return merged;
}
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export class MetricsCollector {
    data;
    explicitPath;
    constructor(customPath) {
        this.explicitPath = customPath;
    }
    /** Resolved storage path; first call pins it for this instance. */
    storagePath() {
        return resolveMetricsPath(this.explicitPath);
    }
    /** Current data, loading the persisted file on first access. */
    state() {
        if (!this.data)
            this.data = this.loadInitial();
        return this.data;
    }
    loadInitial() {
        const path = this.storagePath();
        try {
            if (existsSync(path)) {
                const raw = readFileSync(path, 'utf8');
                const parsed = JSON.parse(raw);
                // v1 counted flat per-tool token estimates and has no measured fields;
                // it is not migrated, the collector restarts on the measured schema.
                if (parsed && parsed.version === 2) {
                    // Backfill fields this build expects but the file predates.
                    return normalizeMetrics(parsed);
                }
            }
        }
        catch {
            // Fallback to empty on corrupt or unreadable file
        }
        return createEmptyMetrics();
    }
    persist() {
        const data = this.state();
        try {
            data.lastUpdatedAt = new Date().toISOString();
            mkdirSync(dirname(this.storagePath()), { recursive: true });
            writeFileSync(this.storagePath(), JSON.stringify(data, null, 2), 'utf8');
        }
        catch {
            // Ignore background file persistence errors in read-only environments
        }
    }
    /**
     * Record a tool pruning evaluation.
     * @param candidatesCount Total candidate tools evaluated
     * @param retainedCount Tools retained after pruning
     * @param measured Exact removal facts: code points dropped and their token price.
     */
    recordPrune(candidatesCount, retainedCount, measured) {
        const pruned = Math.max(0, candidatesCount - retainedCount);
        this.state().toolPruner.evaluations += 1;
        this.state().toolPruner.toolsPruned += pruned;
        this.state().toolPruner.toolsRetained += retainedCount;
        this.state().toolPruner.removedSchemaChars += measured.removedChars;
        this.state().toolPruner.estimatedTokensSaved += measured.estimatedTokens;
        if (this.state().toolPruner.tokenSource !== measured.tokenSource) {
            this.state().toolPruner.tokenSource = 'mixed';
        }
        this.persist();
    }
    /**
     * Record a loop guard check outcome.
     */
    recordLoopCheck(outcome) {
        this.state().loopGuard.checks += 1;
        if (outcome === 'warn') {
            this.state().loopGuard.warned += 1;
            this.state().loopGuard.notices += 1;
        }
        else if (outcome === 'interrupt') {
            this.state().loopGuard.interrupted += 1;
            this.state().loopGuard.notices += 1;
        }
        else if (outcome === 'uncertain') {
            this.state().loopGuard.uncertain += 1;
        }
        this.persist();
    }
    /** Record a denial produced by the deterministic envelope. */
    recordHardDeny() {
        this.state().safetyGuard.screened += 1;
        this.state().safetyGuard.blocked += 1;
        this.state().safetyGuard.hardDenied += 1;
        this.persist();
    }
    /** Record a denial produced by a fail-closed policy on an unusable verdict. */
    recordUncertainDeny() {
        this.state().safetyGuard.screened += 1;
        this.state().safetyGuard.blocked += 1;
        this.state().safetyGuard.uncertainDenied += 1;
        this.persist();
    }
    /**
     * Record a safety guard pre-execution screen.
     */
    recordSafetyCheck(outcome) {
        if (outcome === 'warn')
            this.state().safetyGuard.warned += 1;
        this.state().safetyGuard.screened += 1;
        if (outcome === 'ask') {
            this.state().safetyGuard.approvals += 1;
        }
        else if (outcome === 'deny') {
            this.state().safetyGuard.blocked += 1;
        }
        this.persist();
    }
    /**
     * Record a retry after a transient inspection failure.
     *
     * Counted so the budget can be sized from data: a rising retry count means the
     * inspection timeout is too tight, which is how the 800ms budget went unnoticed.
     */
    recordSafetyRetry() {
        this.state().safetyGuard.inspectionRetries += 1;
        this.persist();
    }
    /** Record an inspection that failed after its retries, so the failure policy applied. */
    recordSafetyInspectionFailure() {
        this.state().safetyGuard.inspectionFailures += 1;
        this.persist();
    }
    /**
     * Record a System One API call latency.
     */
    recordCall(latencyMs, success = true, accounting = {}) {
        this.state().systemOne.totalCalls += 1;
        this.state().systemOne.inputBytes += accounting.inputBytes ?? 0;
        this.state().systemOne.estimatedCostUsd += accounting.estimatedCostUsd ?? 0;
        if (accounting.cacheHit)
            this.state().systemOne.cacheHits += 1;
        if (accounting.decisionError)
            this.state().systemOne.decisionErrors += 1;
        if (success) {
            // A cache hit must not dilute the measured latency of real decisions.
            if (!accounting.cacheHit) {
                this.state().systemOne.totalLatencyMs += latencyMs;
                this.state().systemOne.latencySamples += 1;
            }
            this.state().systemOne.avgLatencyMs = Math.round(this.state().systemOne.totalLatencyMs / Math.max(1, this.state().systemOne.latencySamples));
        }
        else {
            this.state().systemOne.errors += 1;
        }
        this.persist();
    }
    /**
     * Record a semantically shaped tool result.
     * @param charsRemoved Exact characters dropped from the model-facing content.
     */
    recordShape(charsRemoved) {
        this.state().resultShaper.shaped += 1;
        this.state().resultShaper.charsRemoved += Math.max(0, charsRemoved);
        this.persist();
    }
    /** Record a decision whose answer was unusable (missing or malformed). */
    recordDecisionError() {
        this.state().systemOne.decisionErrors += 1;
        this.persist();
    }
    /**
     * Return an immutable snapshot of current metrics, plus the derived cost facts.
     *
     * The derived numbers answer the two questions a reader actually asks - what does
     * one decision cost, and what does a cache hit buy - and they are computed here so
     * they can never disagree with the counters they are computed from.
     */
    getSnapshot() {
        const snapshot = JSON.parse(JSON.stringify(this.state()));
        const calls = Math.max(1, snapshot.systemOne.totalCalls);
        const billed = Math.max(1, snapshot.systemOne.totalCalls - snapshot.systemOne.cacheHits);
        snapshot.systemOne.costPerDecisionUsd = snapshot.systemOne.estimatedCostUsd / calls;
        snapshot.systemOne.costPerBilledCallUsd = snapshot.systemOne.estimatedCostUsd / billed;
        snapshot.systemOne.cacheHitRate = snapshot.systemOne.cacheHits / calls;
        return snapshot;
    }
    /**
     * Tokens saved, measured only where measurement exists: the removed tool
     * schemas. Loop notices prevent work but their avoided cost is not measurable,
     * so they are reported as a count instead of an invented token total.
     */
    getTotalTokensSaved() {
        return this.state().toolPruner.estimatedTokensSaved;
    }
    /**
     * Render a human-friendly Markdown dashboard card.
     */
    renderMarkdownDashboard() {
        const totalTokens = this.getTotalTokensSaved();
        const derived = this.getSnapshot().systemOne;
        const formattedTokens = totalTokens >= 1_000_000
            ? `${(totalTokens / 1_000_000).toFixed(2)}M`
            : totalTokens >= 1_000
                ? `${(totalTokens / 1_000).toFixed(1)}K`
                : String(totalTokens);
        return [
            `### 🛡️ TypeSafe Jev 守护与收益看板`,
            ``,
            `| 守护维度 | 核心拦截/优化战果 | 预估 Token / 成本收益 |`,
            `| :--- | :--- | :--- |`,
            `| **🛠️ 工具动态剪枝** | 评估 **${this.state().toolPruner.evaluations}** 次，裁剪 **${this.state().toolPruner.toolsPruned}** 个次无关工具（精确移除 **${this.state().toolPruner.removedSchemaChars}** 字符） | 省约 **${(this.state().toolPruner.estimatedTokensSaved / 1000).toFixed(1)}K** Tokens（口径：${this.state().toolPruner.tokenSource === 'tokenMeter' ? 'DSH tokenMeter 估算器' : this.state().toolPruner.tokenSource === 'mixed' ? 'tokenMeter 与本地启发混合' : '本地启发式'}） |`,
            `| **🔄 死循环及早止损** | 检查 **${this.state().loopGuard.checks}** 次，阻断 **${this.state().loopGuard.interrupted}** 次、警示 **${this.state().loopGuard.warned}** 次，共注入 **${this.state().loopGuard.notices}** 条提示 | 不做 token 折算（避免成本不可测），仅报计数；判定不可用 **${this.state().loopGuard.uncertain}** 次 |`,
            `| **🔒 执行安全护栏** | 审查 **${this.state().safetyGuard.screened}** 次，阻断 **${this.state().safetyGuard.blocked}** 次（确定性 **${this.state().safetyGuard.hardDenied}** / 判定不可用 fail-closed **${this.state().safetyGuard.uncertainDenied}**），审批 **${this.state().safetyGuard.approvals}** 次，无法弹窗而放行告警 **${this.state().safetyGuard.warned}** 次 | 确定性外壳 0 次模型调用即可拒止；检查重试 **${this.state().safetyGuard.inspectionRetries}** 次、最终失败 **${this.state().safetyGuard.inspectionFailures}** 次（用于校准 inspectionTimeoutMs） |`,
            `| **🧩 语义结果整形** | 整形 **${this.state().resultShaper.shaped}** 次，精确移除 **${this.state().resultShaper.charsRemoved}** 字符 | 默认关闭；仅对输出密集型工具的重复内容生效，不可用时原样返回 |`,
            `| **⚡ System One 响应** | 累计决策 **${this.state().systemOne.totalCalls}** 次（缓存命中 **${this.state().systemOne.cacheHits}**），平均延迟 **${this.state().systemOne.avgLatencyMs}ms**，错误 **${this.state().systemOne.errors}** | 输入 **${(this.state().systemOne.inputBytes / 1024).toFixed(1)}KB**，按 $0.042/M 输入计约 **$${this.state().systemOne.estimatedCostUsd.toFixed(4)}**（输出免费） |`,
            ``,
            `| **💰 每次判定成本** | 累计 **$${derived.costPerDecisionUsd.toFixed(6)}** / 次；只看计费调用为 **$${derived.costPerBilledCallUsd.toFixed(6)}** / 次 | 相同载荷缓存命中率 **${(derived.cacheHitRate * 100).toFixed(0)}%**；按 $0.042/M 输入计，输出免费 |`,
            `> 💡 **累计可测收益**：工具 Schema 精确移除 **${this.state().toolPruner.removedSchemaChars}** 字符，折算 **~${formattedTokens}** Tokens；死循环与安全拦截只报计数，不做不可测的 token 折算。`,
            `> ⏱️ 统计起始自：\`${this.state().firstRecordedAt.replace('T', ' ').slice(0, 19)}\`（最新更新：\`${this.state().lastUpdatedAt.replace('T', ' ').slice(0, 19)}\`）`,
        ].join('\n');
    }
    /**
     * Reset all metrics to zero.
     */
    reset() {
        this.data = createEmptyMetrics();
        this.persist();
    }
}
/** Global shared instance */
export const defaultMetrics = new MetricsCollector();
//# sourceMappingURL=metrics.js.map