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
/** One model-facing content block, as the tools service carries it. */
export interface ContentBlock {
    type: string;
    text?: string;
    [key: string]: unknown;
}
/**
 * Text of a tool result, whether it arrives as a plain string or as the block
 * array the real tools service uses. Returning undefined means there is nothing
 * textual to shape.
 */
export declare function extractText(content: unknown): string | undefined;
/**
 * Rebuild the content with the shaped text. In the block form the text blocks
 * collapse into one, and every non-text block keeps its relative position —
 * the same property DSH's own pruner preserves.
 */
export declare function replaceText(content: unknown, text: string): unknown;
export declare const DEFAULT_SHAPE_TOOLS: string[];
export declare const DROP_MARKER = "[... %d lines dropped by TypeSafe result shaper ...]";
/** Documented defaults; `tests/docs-consistency.spec.ts` keeps README in step. */
export declare const DEFAULT_THRESHOLD_CHARS = 8000;
export declare const DEFAULT_MAX_PER_TURN = 2;
export declare const DEFAULT_LINES_PER_SEGMENT = 40;
export declare const DEFAULT_MAX_SEGMENTS = 24;
export declare const DEFAULT_KEEP_THRESHOLD = 0.5;
/** Characters of each block sent for judgement; the model judges, it does not read. */
export declare const DEFAULT_BLOCK_PREVIEW_CHARS = 600;
/** The shaping request is the plugin's largest, so it gets its own budget. */
export declare const DEFAULT_REQUEST_TIMEOUT_MS = 4000;
/**
 * Minimum separation between the highest and lowest keep-probability for the
 * shaper to act. Below it the model is not discriminating and dropping blocks
 * would be arbitrary.
 */
export declare const DEFAULT_SPREAD_THRESHOLD = 0.15;
/** Group lines into contiguous segments so one question covers a coherent block. */
export declare function segmentText(text: string, linesPerSegment: number, maxSegments: number): string[];
/**
 * Cheap pre-check: is this output dominated by low-information bulk?
 *
 * Byte-identical repetition alone is too narrow: build logs, dependency trees
 * and file listings vary on every line (a counter, a path, a version) and are
 * exactly the output that fills a context window. Volume and structural
 * repetition both count, and everything still passes the model's per-block
 * judgement before anything is dropped.
 */
export declare function looksRepetitive(text: string): boolean;
export declare class ResultShaperService {
    private readonly getClient;
    private readonly config;
    private shapedThisTurn;
    /**
     * Set when the model failed to separate the blocks. Every measured question
     * shape behaves this way on bulk output (docs/calibration.md §9), so once it
     * happens the rest of the turn skips further shaping attempts instead of
     * spending another bounded request on the same non-answer.
     */
    private declinedThisTurn;
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