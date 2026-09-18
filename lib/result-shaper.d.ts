/**
 * Semantic shaping for oversized tool output.
 *
 * DSH already caps oversized results twice, both model-free and both blind to
 * meaning: `dsh-spill-policy` keeps a head/tail preview at result time, and
 * `dsh-compaction-tool-result-pruner` keeps a head/tail when compaction
 * triggers — its own Dev Note defers "semantic middle selection" because it
 * "would need a model or structured heuristics".
 *
 * The decision unit is a **line shape**, not a block: lines are clustered by
 * normalising numbers and hashes, and one representative per cluster is
 * classified by kind with its text embedded in its own question. Measured
 * against the live model (docs/calibration.md §9):
 *
 * - "which part of this output matters" is unreliable in every phrasing tried —
 *   flat distributions, or confident answers on pure noise
 * - "what kind of line is this" is reliable once each question carries its own
 *   sample, and it collapses 600 lines into a handful of decisions
 *
 * Only warning and failure clusters survive; everything else is dropped with a
 * marker, and nothing is dropped when the model keeps nothing. Any failure
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
export declare const DEFAULT_KEEP_KINDS: string[];
export declare const DEFAULT_MIN_KIND_CONFIDENCE = 0.6;
export declare const DEFAULT_MAX_CLUSTERS = 24;
export declare const DEFAULT_SAMPLE_CHARS = 400;
/** The closed label set the classifier chooses from. */
export declare const KIND_CRITERIA: Record<string, string>;
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
/** Shape of a line with numbers and hashes normalised, so variants share a key. */
export declare function lineShape(line: string): string;
export interface LineCluster {
    /** Normalised shape shared by every line in the cluster. */
    shape: string;
    /** How many lines collapse into this cluster. */
    count: number;
    /** First line, used as the sample the classifier sees. */
    sample: string;
}
/** Group lines that differ only in numbers or hashes. */
export declare function clusterLines(text: string): LineCluster[];
/**
 * Cheap pre-check: is this output dominated by low-information bulk?
 *
 * Byte-identical repetition alone is too narrow: build logs, dependency trees
 * and file listings vary on every line (a counter, a path, a version) and are
 * exactly the output that fills a context window. Volume and structural
 * repetition both count, and the classifier still decides what survives.
 */
export declare function looksRepetitive(text: string): boolean;
export interface ShapeOutcome {
    text: string;
    keptClusters: number;
    droppedClusters: number;
    droppedLines: number;
    latencyMs: number;
}
export declare class ResultShaperService {
    private readonly getClient;
    private readonly config;
    private shapedThisTurn;
    /**
     * Set when the model kept nothing. That is the honest answer for pure noise,
     * but re-asking in the same turn would only spend another request, so the rest
     * of the turn skips shaping.
     */
    private declinedThisTurn;
    constructor(getClient: () => TypeSafeClient, config?: ResultShaperConfig);
    /** Reset the per-turn budget; called on each new user instruction. */
    resetTurnBudget(): void;
    shouldConsider(exec: ToolExecution, content: string): boolean;
    /**
     * Classify each distinct line shape and keep only the clusters that report a
     * warning or a failure.
     * @returns the shaped text, or undefined when shaping is not justified.
     */
    shape(content: string, toolName: string): Promise<ShapeOutcome | undefined>;
}
export declare function apply(ctx: CordisContext, config?: ResultShaperConfig): () => void;
//# sourceMappingURL=result-shaper.d.ts.map