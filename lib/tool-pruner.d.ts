/**
 * Dynamic tool and skill pruner using TypeSafe AI.
 * Ranks and filters tools to reduce context rot and speed up LLM inference.
 * @module dsh-jev/tool-pruner
 */
import { TypeSafeClient } from './client.js';
import type { CordisContext, ToolDefinitionMinimal, ToolPrunerConfig } from './types.js';
export declare const name = "typesafe-tool-pruner";
export declare const DEFAULT_ALWAYS_RETAIN: string[];
export declare class ToolPrunerService {
    private readonly getClient;
    private readonly config;
    constructor(getClient: () => TypeSafeClient, config?: ToolPrunerConfig);
    /**
     * Filter tools down to the most relevant subset for the current task context.
     */
    pruneTools(userIntent: string, candidates: ToolDefinitionMinimal[]): Promise<ToolDefinitionMinimal[]>;
}
export declare function apply(ctx: CordisContext, config?: ToolPrunerConfig): any;
//# sourceMappingURL=tool-pruner.d.ts.map