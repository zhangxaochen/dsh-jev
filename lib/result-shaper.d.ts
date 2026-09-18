/**
 * Semantic result shaping for oversized tool output.
 *
 * DSH already caps oversized results twice, both model-free and both blind to
 * meaning: `dsh-spill-policy` keeps a head/tail preview at result time, and
 * `dsh-compaction-tool-result-pruner` keeps a head/tail when compaction
 * triggers — its own Dev Note defers "semantic middle selection" because it
 * "would need a model or structured heuristics".
 *
 * This module is that semantic selection, and nothing else: it keeps the
 * interesting middle and drops repetition, only for output-heavy tools, only
 * above a size threshold, only a bounded number of times per turn, and only
 * when the cheap pre-check says the text is actually repetitive. Any failure
 * returns the original content untouched.
 * @module dsh-jev/result-shaper
 */
import { type TypeSafeClient } from './typesafe-client.js';
import type { CordisContext, ResultShaperConfig, ToolExecution } from './types.js';
export declare const name = "typesafe-result-shaper";
export declare const DEFAULT_SHAPE_TOOLS: string[];
export declare const DROP_MARKER = "[... %d lines dropped by TypeSafe result shaper ...]";
/** Documented defaults; `tests/docs-consistency.spec.ts` keeps README in step. */
export declare const DEFAULT_THRESHOLD_CHARS = 8000;
export declare const DEFAULT_MAX_PER_TURN = 2;
export declare const DEFAULT_LINES_PER_SEGMENT = 40;
export declare const DEFAULT_MAX_SEGMENTS = 24;
export declare const DEFAULT_KEEP_THRESHOLD = 0.5;
/** Group lines into contiguous segments so one question covers a coherent block. */
export declare function segmentText(text: string, linesPerSegment: number, maxSegments: number): string[];
/** Cheap pre-check: is this output repetitive enough that shaping can pay off? */
export declare function looksRepetitive(text: string): boolean;
export declare class ResultShaperService {
    private readonly getClient;
    private readonly config;
    private shapedThisTurn;
    constructor(getClient: () => TypeSafeClient, config?: ResultShaperConfig);
    /** Reset the per-turn budget; called on each new user instruction. */
    resetTurnBudget(): void;
    shouldConsider(exec: ToolExecution, content: string): boolean;
    /**
     * Keep the segments Jev judges still informative, drop the rest.
     * @returns the shaped text, or undefined when shaping is not justified.
     */
    shape(content: string, toolName: string): Promise<{
        text: string;
        droppedSegments: number;
        keptSegments: number;
        latencyMs: number;
    } | undefined>;
}
export declare function apply(ctx: CordisContext, config?: ResultShaperConfig): () => void;
//# sourceMappingURL=result-shaper.d.ts.map