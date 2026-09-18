/**
 * Metrics tracking and telemetry for TypeSafe AI (dsh-jev).
 * Records tool pruning token savings, loop guard interruptions, safety screenings, and latency.
 * @module dsh-jev/metrics
 */
export interface JevMetricsData {
    version: 1;
    firstRecordedAt: string;
    lastUpdatedAt: string;
    toolPruner: {
        evaluations: number;
        toolsPruned: number;
        toolsRetained: number;
        estimatedTokensSaved: number;
    };
    loopGuard: {
        checks: number;
        interrupted: number;
        warned: number;
        estimatedTokensSaved: number;
    };
    safetyGuard: {
        screened: number;
        blocked: number;
        approvals: number;
    };
    systemOne: {
        totalCalls: number;
        totalLatencyMs: number;
        avgLatencyMs: number;
        errors: number;
        /** Billed input bytes sent to System One (cache hits cost nothing). */
        inputBytes: number;
        /** Estimated USD cost at $0.042 per million input tokens; output is free. */
        estimatedCostUsd: number;
        /** Decisions served from the identical-payload cache. */
        cacheHits: number;
        /** Decisions whose answer came back unusable (missing or malformed). */
        decisionErrors: number;
    };
}
/** Accounting facts attached to one System One call. */
export interface CallAccounting {
    inputBytes?: number;
    estimatedCostUsd?: number;
    latencyMs?: number;
    cacheHit?: boolean;
    decisionError?: boolean;
}
/** Estimated tokens per pruned MCP/system tool schema */
export declare const TOKENS_PER_PRUNED_TOOL = 150;
/** Estimated tokens saved per early-stopped runaway loop (averages 3-5 wasted cycles) */
export declare const TOKENS_PER_INTERRUPTED_LOOP = 15000;
export declare class MetricsCollector {
    private data;
    private readonly storagePath;
    constructor(customPath?: string);
    private loadInitial;
    private persist;
    /**
     * Record a tool pruning evaluation.
     * @param candidatesCount Total candidate tools evaluated
     * @param retainedCount Tools retained after pruning
     * @param exactTokensSaved Optional exact token count based on pruned schema sizes
     */
    recordPrune(candidatesCount: number, retainedCount: number, exactTokensSaved?: number): void;
    /**
     * Record a loop guard check outcome.
     */
    recordLoopCheck(outcome: 'normal' | 'warn' | 'interrupt'): void;
    /**
     * Record a safety guard pre-execution screen.
     */
    recordSafetyCheck(outcome: 'pass' | 'ask' | 'deny'): void;
    /**
     * Record a System One API call latency.
     */
    recordCall(latencyMs: number, success?: boolean, accounting?: CallAccounting): void;
    /** Record a decision whose answer was unusable (missing or malformed). */
    recordDecisionError(): void;
    /**
     * Return an immutable snapshot of current metrics.
     */
    getSnapshot(): JevMetricsData;
    /**
     * Total tokens saved across all modules.
     */
    getTotalTokensSaved(): number;
    /**
     * Render a human-friendly Markdown dashboard card.
     */
    renderMarkdownDashboard(): string;
    /**
     * Reset all metrics to zero.
     */
    reset(): void;
}
/** Global shared instance */
export declare const defaultMetrics: MetricsCollector;
//# sourceMappingURL=metrics.d.ts.map