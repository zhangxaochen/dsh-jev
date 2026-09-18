/**
 * Metrics tracking and telemetry for TypeSafe AI (dsh-jev).
 * Records tool pruning token savings, loop guard interruptions, safety screenings, and latency.
 * @module dsh-jev/metrics
 */
export interface JevMetricsData {
    version: 2;
    firstRecordedAt: string;
    lastUpdatedAt: string;
    toolPruner: {
        evaluations: number;
        toolsPruned: number;
        toolsRetained: number;
        /** Exact Unicode code points removed from the model-facing tool surface. */
        removedSchemaChars: number;
        /** Tokens the removed schemas were priced at, by whichever estimator was available. */
        estimatedTokensSaved: number;
        /** Which estimator produced `estimatedTokensSaved`. */
        tokenSource: 'tokenMeter' | 'heuristic' | 'mixed';
    };
    loopGuard: {
        checks: number;
        interrupted: number;
        warned: number;
        /** Notices actually injected into the conversation. */
        notices: number;
        /** Decisions skipped because the answer was unusable. */
        uncertain: number;
    };
    safetyGuard: {
        screened: number;
        blocked: number;
        approvals: number;
        /** Denials produced by the deterministic envelope. */
        hardDenied: number;
        /** Denials produced because the verdict was unknown and the policy fails closed. */
        uncertainDenied: number;
    };
    resultShaper: {
        shaped: number;
        charsRemoved: number;
    };
    systemOne: {
        totalCalls: number;
        totalLatencyMs: number;
        avgLatencyMs: number;
        errors: number;
        /** Successful calls that actually reached the model, excluded cache hits and failures. */
        latencySamples: number;
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
/**
 * Fallback characters-per-token used only when no token estimator is available.
 * The previous build multiplied a flat 150 tokens per pruned tool and claimed
 * 15000 tokens saved per interrupted loop; neither was measured, so both are gone.
 */
export declare const FALLBACK_CHARS_PER_TOKEN = 3.5;
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
     * @param measured Exact removal facts: code points dropped and their token price.
     */
    recordPrune(candidatesCount: number, retainedCount: number, measured: {
        removedChars: number;
        estimatedTokens: number;
        tokenSource: 'tokenMeter' | 'heuristic';
    }): void;
    /**
     * Record a loop guard check outcome.
     */
    recordLoopCheck(outcome: 'normal' | 'warn' | 'interrupt' | 'uncertain'): void;
    /** Record a denial produced by the deterministic envelope. */
    recordHardDeny(): void;
    /** Record a denial produced by a fail-closed policy on an unusable verdict. */
    recordUncertainDeny(): void;
    /**
     * Record a safety guard pre-execution screen.
     */
    recordSafetyCheck(outcome: 'pass' | 'ask' | 'deny'): void;
    /**
     * Record a System One API call latency.
     */
    recordCall(latencyMs: number, success?: boolean, accounting?: CallAccounting): void;
    /**
     * Record a semantically shaped tool result.
     * @param charsRemoved Exact characters dropped from the model-facing content.
     */
    recordShape(charsRemoved: number): void;
    /** Record a decision whose answer was unusable (missing or malformed). */
    recordDecisionError(): void;
    /**
     * Return an immutable snapshot of current metrics.
     */
    getSnapshot(): JevMetricsData;
    /**
     * Tokens saved, measured only where measurement exists: the removed tool
     * schemas. Loop notices prevent work but their avoided cost is not measurable,
     * so they are reported as a count instead of an invented token total.
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