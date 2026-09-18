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
export declare function apply(ctx: CordisContext, config?: LoopGuardConfig): () => void;
//# sourceMappingURL=loop-guard.d.ts.map