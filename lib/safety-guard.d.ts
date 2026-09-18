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
interface HardDenyRule {
    id: string;
    reason: string;
    test: RegExp;
}
/**
 * Strings worth inspecting for one tool call. Patterns must never be matched
 * against a JSON envelope alone: quoting hides the end of a command, so a
 * `$`-anchored pattern silently stops matching `rm -rf /`.
 */
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
export declare function apply(ctx: CordisContext, config?: SafetyGuardConfig): () => void;
export {};
//# sourceMappingURL=safety-guard.d.ts.map