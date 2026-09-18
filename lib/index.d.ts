/**
 * Entry point for TypeSafe AI integration suite for DeepSeek Harness (dsh).
 * @module dsh-jev
 */
import type { CordisContext, TypeSafeSuiteConfig } from './types.js';
export * from './types.js';
export * from './typesafe-client.js';
export * from './metrics.js';
export { apply as applyLoopGuard, name as loopGuardName } from './loop-guard.js';
export { apply as applySafetyGuard, name as safetyGuardName } from './safety-guard.js';
export { apply as applyToolPruner, name as toolPrunerName, ToolPrunerService } from './tool-pruner.js';
export { apply as applySkillRouter, name as skillRouterName, SkillRouterService } from './skill-router.js';
export { registerJevTools } from './ask-tools.js';
export declare const name = "dsh-jev";
export declare const inject: string[];
/**
 * Mount the full TypeSafe plugin suite onto a Cordis context.
 */
export declare function apply(ctx: CordisContext, config?: TypeSafeSuiteConfig): () => void;
declare const _default: {
    name: string;
    apply: typeof apply;
};
export default _default;
//# sourceMappingURL=index.d.ts.map