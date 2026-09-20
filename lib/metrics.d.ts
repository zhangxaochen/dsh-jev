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
        /** `ask` verdicts that proceeded because the session could not prompt (headlessAsk=warn). */
        warned: number;
        /** Denials produced by the deterministic envelope. */
        hardDenied: number;
        /** Denials produced because the verdict was unknown and the policy fails closed. */
        uncertainDenied: number;
        /** Inspections retried after a transient failure (timeout, 429, 5xx). */
        inspectionRetries: number;
        /** Inspections that failed after their retries, so the failure policy applied. */
        inspectionFailures: number;
        /**
         * When the last inspection failed (ISO), or `''` when none ever has.
         *
         * The counter alone cannot separate a single flake from an upstream outage; the
         * timestamp is what makes "is the guard degraded right now" answerable. Defaulted
         * to a string rather than null so `normalizeMetrics` keeps a stored value - its
         * type check would drop a string sitting under a null default.
         */
        lastInspectionFailureAt: string;
        /**
         * Ids of the configured `safetyGuard.rules`, in configuration order.
         *
         * Recorded so the dashboard can show a rule that has never fired: a count of 0 is
         * the only way to tell "this rule does not work" from "this rule has nothing to do".
         */
        ruleIds: string[];
        /** Hits per rule id: how often it matched, when it last did, and the action it took. */
        ruleHits: Record<string, {
            count: number;
            lastAt: string;
            action: string;
        }>;
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
 * A snapshot plus the facts derived from it: what one decision costs.
 *
 * Derived on read and deliberately never persisted - a stored copy would go stale
 * the moment a counter moved, and `normalizeMetrics` would keep the stale number
 * because its type still matches the default.
 */
export interface JevMetricsSnapshot extends JevMetricsData {
    systemOne: JevMetricsData['systemOne'] & {
        /** Cost per recorded decision, counting cache hits and failed calls. */
        costPerDecisionUsd: number;
        /** Cost per call that actually billed input (a cache hit bills nothing). */
        costPerBilledCallUsd: number;
        /** Share of decisions answered from the identical-payload cache. */
        cacheHitRate: number;
    };
}
/**
 * Fallback characters-per-token used only when no token estimator is available.
 * The previous build multiplied a flat 150 tokens per pruned tool and claimed
 * 15000 tokens saved per interrupted loop; neither was measured, so both are gone.
 */
export declare const FALLBACK_CHARS_PER_TOKEN = 3.5;
/** Environment override for the metrics file, used by verification scripts. */
export declare const METRICS_PATH_ENV = "DSH_JEV_METRICS_PATH";
/**
 * Where the collector persists, resolved on first use rather than at import.
 *
 * A script that merely imports the plugins would otherwise construct the
 * collector against the live file and overwrite the very metrics an operator
 * reads to judge a deployment. Resolving late lets a tool point the collector at
 * a scratch file after imports and before its first decision.
 */
export declare function resolveMetricsPath(explicit?: string): string;
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
export declare function normalizeMetrics(stored: unknown): JevMetricsData;
export declare class MetricsCollector {
    private data?;
    private readonly explicitPath?;
    constructor(customPath?: string);
    /** Resolved storage path; first call pins it for this instance. */
    private storagePath;
    /** Current data, loading the persisted file on first access. */
    private state;
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
    recordSafetyCheck(outcome: 'pass' | 'ask' | 'deny' | 'warn'): void;
    /**
     * Record a retry after a transient inspection failure.
     *
     * Counted so the budget can be sized from data: a rising retry count means the
     * inspection timeout is too tight, which is how the 800ms budget went unnoticed.
     */
    recordSafetyRetry(): void;
    /** Record an inspection that failed after its retries, so the failure policy applied. */
    recordSafetyInspectionFailure(): void;
    /**
     * Register the configured safety rule ids.
     *
     * Without this the dashboard could only list rules that already fired, and "a rule I
     * wrote never runs" - the failure an operator is actually looking for - stays invisible.
     */
    registerSafetyRules(ids: string[]): void;
    /**
     * Record one hit of a user-defined safety rule.
     * @param ruleId the rule's configured id
     * @param action the rule's configured action (`deny` / `ask` / `warn`)
     */
    recordRuleHit(ruleId: string, action: string): void;
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
     * Return an immutable snapshot of current metrics, plus the derived cost facts.
     *
     * The derived numbers answer the two questions a reader actually asks - what does
     * one decision cost, and what does a cache hit buy - and they are computed here so
     * they can never disagree with the counters they are computed from.
     */
    getSnapshot(): JevMetricsSnapshot;
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