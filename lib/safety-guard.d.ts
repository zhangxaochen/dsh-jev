/**
 * Execution safety gatekeeper plugin using TypeSafe AI.
 * Intercepts tools/pre-execute to screen sensitive commands for destructive actions or security hazards.
 * @module dsh-jev/safety-guard
 */
import type { CordisContext, SafetyGuardConfig } from './types.js';
export declare const name = "typesafe-safety-guard";
export declare const DEFAULT_GUARDED_TOOLS: string[];
export declare function apply(ctx: CordisContext, config?: SafetyGuardConfig): () => void;
//# sourceMappingURL=safety-guard.d.ts.map