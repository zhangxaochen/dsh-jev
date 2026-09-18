/**
 * Dynamic tool and skill pruner using TypeSafe AI.
 * Ranks and filters tools to reduce context rot and speed up LLM inference.
 * @module dsh-jev/tool-pruner
 */
import { TypeSafeClient } from './typesafe-client.js';
import type { CordisContext, ToolDefinitionMinimal, ToolPrunerConfig } from './types.js';
export declare const name = "typesafe-tool-pruner";
export declare const DEFAULT_ALWAYS_RETAIN: string[];
/** Minimal shape of the harness token estimator, kept structural on purpose. */
export interface TokenEstimator {
    estimateMessage?: (message: unknown) => number;
}
/**
 * Price the tool schemas that were removed from the model-facing surface.
 *
 * The previous build multiplied a flat 150 tokens per tool. Here the removed
 * text is counted exactly and priced with the harness estimator when one is
 * mounted, falling back to a documented characters-per-token constant.
 */
export declare function measureRemovedTools(meter: TokenEstimator | undefined, prunedTools: ToolDefinitionMinimal[]): {
    removedChars: number;
    estimatedTokens: number;
    tokenSource: 'tokenMeter' | 'heuristic';
};
export declare class ToolPrunerService {
    private readonly getClient;
    private readonly config;
    constructor(getClient: () => TypeSafeClient, config?: ToolPrunerConfig & {
        meter?: TokenEstimator;
    });
    /**
     * Filter tools down to the most relevant subset for the current task context.
     */
    pruneTools(userIntent: string, candidates: ToolDefinitionMinimal[]): Promise<ToolDefinitionMinimal[]>;
}
export declare function apply(ctx: CordisContext, config?: ToolPrunerConfig): () => void;
//# sourceMappingURL=tool-pruner.d.ts.map