/**
 * Execution safety gatekeeper plugin using TypeSafe AI.
 *
 * Two layers, deliberately ordered:
 * 1. a synchronous deterministic envelope registered through `ctx.tools.guard()`
 *    for shapes that must never run (filesystem-root deletion, disk overwrite,
 *    credential exfiltration). No later listener can force-allow a guarded denial.
 * 2. a semantic verdict from Jev on `tools/pre-execute`, which catches the shapes
 *    no pattern list ever covered.
 *
 * Failure policy is explicit and fail-closed by default for guarded tools: a
 * timeout, API error, or answer without a usable probability denies the call
 * instead of silently allowing it.
 * @module dsh-jev/safety-guard
 */
import type { CordisContext, SafetyGuardConfig, ToolExecution } from './types.js';
export declare const name = "typesafe-safety-guard";
export declare const DEFAULT_GUARDED_TOOLS: string[];
/** Credential classes, so a placeholder or a doc link is not read as a live secret. */
export declare const CREDENTIAL_CRITERIA: Record<string, string>;
/** Documented defaults; `tests/docs-consistency.spec.ts` keeps README in step. */
export declare const DEFAULT_BLOCK_THRESHOLD = 0.85;
export declare const DEFAULT_ASK_APPROVAL_THRESHOLD = 0.5;
/**
 * Budget for the semantic inspection, in milliseconds.
 *
 * This is deliberately not `client.pathTimeoutMs` (800ms). That budget was sized for
 * the advisory path - loop-guard notices, where failing open costs nothing - while this
 * path fails closed: an inspection that times out denies a guarded tool. Measured cold
 * calls take 700-750ms and the live checks recorded after the host restart ran 587-777ms,
 * so an 800ms budget sat at the ceiling and turned a latency spike into a full tool
 * lockdown. 3500ms leaves ~4.5x headroom over the slowest measured call; the skill
 * router hit the identical wall with 800ms and was given its own 4000ms budget for it.
 */
export declare const DEFAULT_INSPECTION_TIMEOUT_MS = 3500;
/**
 * Extra attempts for a *transient* inspection failure (timeout, abort, 429, 5xx).
 *
 * One retry removes the common case - a single slow call - without hiding a broken
 * endpoint: a permanent failure still reaches the `onError` policy after the retry.
 * A verdict that came back but is unusable is not retried; that is `onUncertain`'s job.
 */
export declare const DEFAULT_INSPECTION_RETRIES = 1;
/** Whether a failed inspection is worth another attempt. */
export declare function isTransientInspectionError(error: unknown): boolean;
interface HardDenyRule {
    id: string;
    reason: string;
    test: RegExp;
}
export declare function inspectableText(exec: ToolExecution): string[];
/**
 * Deterministic hard denies. Each entry is a shape with no legitimate agent use;
 * everything else is left to the semantic layer instead of an ever-growing list.
 */
export declare const HARD_DENY_RULES: HardDenyRule[];
/** Run the deterministic envelope over one tool call. */
export declare function deterministicVerdict(exec: ToolExecution): {
    id: string;
    reason: string;
} | undefined;
/** Thresholds that turn hazard probabilities into an action. */
export interface SafetyThresholds {
    blockThreshold: number;
    askApprovalThreshold: number;
}
/**
 * The shipped semantic rule, as a pure function: hazard probabilities in, an
 * action out.
 *
 * Exported so the benchmark drives this rule rather than a copy of it. The bench
 * is the CI gate for the safety guard, and while it reimplemented these
 * thresholds a change here would not have failed it (docs/calibration.md §13).
 */
export declare function evaluateHazard(answers: Record<string, any>, thresholds: SafetyThresholds): {
    action: 'deny' | 'ask' | 'pass' | 'unknown';
    maxHazard?: number;
    riskScore?: number;
};
export declare function apply(ctx: CordisContext, config?: SafetyGuardConfig): () => void;
export {};
//# sourceMappingURL=safety-guard.d.ts.map