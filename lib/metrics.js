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
            hardDenied: 0,
            uncertainDenied: 0,
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
export class MetricsCollector {
    data;
    storagePath;
    constructor(customPath) {
        this.storagePath = customPath ?? join(homedir(), '.dsh', 'jev-stats.json');
        this.data = this.loadInitial();
    }
    loadInitial() {
        try {
            if (existsSync(this.storagePath)) {
                const raw = readFileSync(this.storagePath, 'utf8');
                const parsed = JSON.parse(raw);
                // v1 counted flat per-tool token estimates and has no measured fields;
                // it is not migrated, the collector restarts on the measured schema.
                if (parsed && parsed.version === 2) {
                    return parsed;
                }
            }
        }
        catch {
            // Fallback to empty on corrupt or unreadable file
        }
        return createEmptyMetrics();
    }
    persist() {
        try {
            this.data.lastUpdatedAt = new Date().toISOString();
            mkdirSync(dirname(this.storagePath), { recursive: true });
            writeFileSync(this.storagePath, JSON.stringify(this.data, null, 2), 'utf8');
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
        this.data.toolPruner.evaluations += 1;
        this.data.toolPruner.toolsPruned += pruned;
        this.data.toolPruner.toolsRetained += retainedCount;
        this.data.toolPruner.removedSchemaChars += measured.removedChars;
        this.data.toolPruner.estimatedTokensSaved += measured.estimatedTokens;
        if (this.data.toolPruner.tokenSource !== measured.tokenSource) {
            this.data.toolPruner.tokenSource = 'mixed';
        }
        this.persist();
    }
    /**
     * Record a loop guard check outcome.
     */
    recordLoopCheck(outcome) {
        this.data.loopGuard.checks += 1;
        if (outcome === 'warn') {
            this.data.loopGuard.warned += 1;
            this.data.loopGuard.notices += 1;
        }
        else if (outcome === 'interrupt') {
            this.data.loopGuard.interrupted += 1;
            this.data.loopGuard.notices += 1;
        }
        else if (outcome === 'uncertain') {
            this.data.loopGuard.uncertain += 1;
        }
        this.persist();
    }
    /** Record a denial produced by the deterministic envelope. */
    recordHardDeny() {
        this.data.safetyGuard.screened += 1;
        this.data.safetyGuard.blocked += 1;
        this.data.safetyGuard.hardDenied += 1;
        this.persist();
    }
    /** Record a denial produced by a fail-closed policy on an unusable verdict. */
    recordUncertainDeny() {
        this.data.safetyGuard.screened += 1;
        this.data.safetyGuard.blocked += 1;
        this.data.safetyGuard.uncertainDenied += 1;
        this.persist();
    }
    /**
     * Record a safety guard pre-execution screen.
     */
    recordSafetyCheck(outcome) {
        this.data.safetyGuard.screened += 1;
        if (outcome === 'ask') {
            this.data.safetyGuard.approvals += 1;
        }
        else if (outcome === 'deny') {
            this.data.safetyGuard.blocked += 1;
        }
        this.persist();
    }
    /**
     * Record a System One API call latency.
     */
    recordCall(latencyMs, success = true, accounting = {}) {
        this.data.systemOne.totalCalls += 1;
        this.data.systemOne.inputBytes += accounting.inputBytes ?? 0;
        this.data.systemOne.estimatedCostUsd += accounting.estimatedCostUsd ?? 0;
        if (accounting.cacheHit)
            this.data.systemOne.cacheHits += 1;
        if (accounting.decisionError)
            this.data.systemOne.decisionErrors += 1;
        if (success) {
            // A cache hit must not dilute the measured latency of real decisions.
            if (!accounting.cacheHit) {
                this.data.systemOne.totalLatencyMs += latencyMs;
                this.data.systemOne.latencySamples += 1;
            }
            this.data.systemOne.avgLatencyMs = Math.round(this.data.systemOne.totalLatencyMs / Math.max(1, this.data.systemOne.latencySamples));
        }
        else {
            this.data.systemOne.errors += 1;
        }
        this.persist();
    }
    /** Record a decision whose answer was unusable (missing or malformed). */
    recordDecisionError() {
        this.data.systemOne.decisionErrors += 1;
        this.persist();
    }
    /**
     * Return an immutable snapshot of current metrics.
     */
    getSnapshot() {
        return JSON.parse(JSON.stringify(this.data));
    }
    /**
     * Tokens saved, measured only where measurement exists: the removed tool
     * schemas. Loop notices prevent work but their avoided cost is not measurable,
     * so they are reported as a count instead of an invented token total.
     */
    getTotalTokensSaved() {
        return this.data.toolPruner.estimatedTokensSaved;
    }
    /**
     * Render a human-friendly Markdown dashboard card.
     */
    renderMarkdownDashboard() {
        const totalTokens = this.getTotalTokensSaved();
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
            `| **🛠️ 工具动态剪枝** | 评估 **${this.data.toolPruner.evaluations}** 次，裁剪 **${this.data.toolPruner.toolsPruned}** 个次无关工具（精确移除 **${this.data.toolPruner.removedSchemaChars}** 字符） | 省约 **${(this.data.toolPruner.estimatedTokensSaved / 1000).toFixed(1)}K** Tokens（口径：${this.data.toolPruner.tokenSource === 'tokenMeter' ? 'DSH tokenMeter 估算器' : this.data.toolPruner.tokenSource === 'mixed' ? 'tokenMeter 与本地启发混合' : '本地启发式'}） |`,
            `| **🔄 死循环及早止损** | 检查 **${this.data.loopGuard.checks}** 次，阻断 **${this.data.loopGuard.interrupted}** 次、警示 **${this.data.loopGuard.warned}** 次，共注入 **${this.data.loopGuard.notices}** 条提示 | 不做 token 折算（避免成本不可测），仅报计数；判定不可用 **${this.data.loopGuard.uncertain}** 次 |`,
            `| **🔒 执行安全护栏** | 审查 **${this.data.safetyGuard.screened}** 次，阻断 **${this.data.safetyGuard.blocked}** 次（确定性 **${this.data.safetyGuard.hardDenied}** / 判定不可用 fail-closed **${this.data.safetyGuard.uncertainDenied}**），审批 **${this.data.safetyGuard.approvals}** 次 | 确定性外壳 0 次模型调用即可拒止 |`,
            `| **⚡ System One 响应** | 累计决策 **${this.data.systemOne.totalCalls}** 次（缓存命中 **${this.data.systemOne.cacheHits}**），平均延迟 **${this.data.systemOne.avgLatencyMs}ms**，错误 **${this.data.systemOne.errors}** | 输入 **${(this.data.systemOne.inputBytes / 1024).toFixed(1)}KB**，按 $0.042/M 输入计约 **$${this.data.systemOne.estimatedCostUsd.toFixed(4)}**（输出免费） |`,
            ``,
            `> 💡 **累计可测收益**：工具 Schema 精确移除 **${this.data.toolPruner.removedSchemaChars}** 字符，折算 **~${formattedTokens}** Tokens；死循环与安全拦截只报计数，不做不可测的 token 折算。`,
            `> ⏱️ 统计起始自：\`${this.data.firstRecordedAt.replace('T', ' ').slice(0, 19)}\`（最新更新：\`${this.data.lastUpdatedAt.replace('T', ' ').slice(0, 19)}\`）`,
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