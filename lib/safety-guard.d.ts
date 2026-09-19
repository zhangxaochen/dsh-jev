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
 * An `ask` verdict in a session that cannot prompt proceeds by default.
 *
 * The alternative - refusing because nobody can answer - punishes the agent for the
 * harness's inability to ask. A pilot measured two of three denials as weak-signal asks
 * (hazard 0.50 and 0.72) against legitimate bash calls, and the arm that hit them ran 12%
 * more steps. Strict unattended runs can set `headlessAsk: 'deny'`.
 */
export declare const DEFAULT_HEADLESS_ASK = "warn";
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
/**
 * What happens when the semantic inspection cannot be obtained at all.
 *
 * `allow` by default: the inspection is an *operational* dependency, and failing closed
 * turns any upstream blip into "every guarded tool is refused" - observed live, where an
 * intermittent upstream failure blocked the operator's shell entirely (~2% of calls, and
 * one 4822ms pair that only the retry rescued). The guard still does its job whenever the
 * judge answers, and the deterministic envelope - which needs no model at all - keeps
 * denying the unambiguous cases (`rm -rf /`) regardless of this setting. The failure is
 * counted (`safetyGuard.inspectionFailures`), warned about and shown on the dashboard, so
 * "the guard was bypassed" stays visible instead of silent.
 *
 * Deployments with a threat model where the judge being unreachable is itself an attack
 * surface should pin `onError: 'deny-guarded'` in their own patch layer.
 */
export declare const DEFAULT_ON_ERROR: SafetyGuardConfig['onError'];
export declare function apply(ctx: CordisContext, config?: SafetyGuardConfig): () => void;
/** Strip credential-shaped material so a command can be logged safely. */
export declare function redactSecrets(text: string): string;
/**
 * A short, redacted preview of what a tool call was about to do.
 *
 * The decision log used to carry only probabilities, so a denial could not be judged after
 * the fact - a pilot produced two denials at hazard 0.50 and 0.72 that nobody could audit.
 * A command-shaped argument is shown as itself rather than as JSON, because that is what a
 * reader needs; anything else falls back to the serialized arguments.
 */
export declare function commandPreview(args: unknown, maxLength?: number): string | undefined;
export {};
//# sourceMappingURL=safety-guard.d.ts.map