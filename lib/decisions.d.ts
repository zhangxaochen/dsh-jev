/**
 * Append-only decision log for calibration.
 *
 * Every semantic decision is recorded with the facts needed to re-derive its
 * threshold later: the question, the answer, its confidence, the action taken,
 * the measured latency and the billed input size. This is the dataset the
 * calibration table in docs/calibration.md is supposed to be built from.
 * @module dsh-jev/decisions
 */
export interface DecisionRecord {
    /** ISO timestamp. */
    ts: string;
    /** Owning module, e.g. `loop-guard` or `safety-guard`. */
    module: string;
    /** Action taken: pass, warn, interrupt, ask, deny, hard-deny. */
    action: string;
    latencyMs?: number;
    /** Answer confidence in [0, 1] when the primitive reports one. */
    confidence?: number;
    /** Deciding probability, e.g. dead-loop bucket mass or hazard probability. */
    probability?: number;
    /** Billed input bytes for this decision (0 for a cache hit or deterministic veto). */
    inputBytes?: number;
    estimatedCostUsd?: number;
    /** Free-form context: tool name, rule id, model score. */
    detail?: Record<string, unknown>;
}
/** A decision as supplied by a guard: `ts` is filled in on append. */
export type DecisionInput = Omit<DecisionRecord, 'ts'> & {
    ts?: string;
};
export declare const DEFAULT_DECISION_LOG: string;
export declare class DecisionLog {
    private readonly path;
    constructor(path?: string);
    /** Append one decision. Never throws: logging must not break an agent turn. */
    append(record: DecisionInput): void;
    /** Read every recorded decision, skipping unparsable lines. */
    read(): DecisionRecord[];
    /**
     * Per-action counts plus the confidence distribution per module, which is what
     * a threshold review actually needs.
     */
    summarize(): {
        total: number;
        byModule: Record<string, Record<string, number>>;
        confidence: Record<string, {
            count: number;
            min: number;
            max: number;
            mean: number;
        }>;
    };
}
/** Shared instance used by the guard plugins. */
export declare const defaultDecisionLog: DecisionLog;
//# sourceMappingURL=decisions.d.ts.map