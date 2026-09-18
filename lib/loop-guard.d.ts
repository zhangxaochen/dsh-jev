/**
 * Loop guard plugin for semantic loop and stagnation interception.
 * Observes tools/post-execute to detect cyclical agent behavior and prompt plan adaptation.
 *
 * Division of labour (measured 2026-09-18, see docs/calibration.md):
 * - exact repeats of the same tool + arguments are DSH's `repeat-tool-reminder` job
 *   (thresholds 3/5/8, canonicalized arguments). This guard defers to it.
 * - this guard judges *near-identical / semantically stagnant* trajectories, and only
 *   when the answer carries enough probability mass and confidence to justify it.
 * @module dsh-jev/loop-guard
 */
import type { CordisContext, LoopGuardConfig } from './types.js';
export declare const name = "typesafe-loop-guard";
/** Buckets of the stuck-severity rubric; index 2 is the "definite dead loop" bucket. */
export declare const STUCK_SEVERITY_CRITERIA: string[];
/** Documented defaults; `tests/docs-consistency.spec.ts` keeps README in step. */
export declare const DEFAULT_TRIGGER_THRESHOLD = 2;
export declare const DEFAULT_NO_PROGRESS_THRESHOLD = 0.3;
export declare const DEFAULT_P_LOOP_THRESHOLD = 0.6;
export declare const DEFAULT_MIN_CONFIDENCE = 0.5;
export declare const DEFAULT_COOLDOWN_STEPS = 3;
export declare const DEFAULT_MAX_HISTORY = 8;
/** Thresholds that decide whether a trajectory counts as stuck. */
export interface LoopGuardThresholds {
    noProgressThreshold: number;
    pLoopThreshold: number;
    minConfidence: number;
}
/**
 * The shipped stuck-trajectory rule, as a pure function.
 *
 * Exported so the benchmark drives this rule instead of a copy of it: the bench is
 * the CI gate for the loop guard, and while it reimplemented the thresholds a
 * change here would not have failed it (docs/calibration.md §13).
 */
export declare function evaluateStuckTrajectory(answers: Record<string, any>, thresholds: LoopGuardThresholds): {
    action: 'interrupt' | 'warn' | 'pass' | 'unknown';
    progress?: number;
    pLoop?: number;
    confidence?: number;
};
export declare function apply(ctx: CordisContext, config?: LoopGuardConfig): () => void;
//# sourceMappingURL=loop-guard.d.ts.map