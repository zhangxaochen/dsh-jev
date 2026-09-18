/**
 * Loop guard plugin for semantic loop and stagnation interception.
 * Observes tools/post-execute to detect cyclical agent behavior and prompt plan adaptation.
 * @module dsh-jev/loop-guard
 */
import type { CordisContext, LoopGuardConfig } from './types.js';
export declare const name = "typesafe-loop-guard";
export declare function apply(ctx: CordisContext, config?: LoopGuardConfig): () => void;
//# sourceMappingURL=loop-guard.d.ts.map