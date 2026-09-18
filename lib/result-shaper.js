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
import { choice, resolveClientFrom } from './typesafe-client.js';
import { defaultMetrics } from './metrics.js';
import { defaultDecisionLog } from './decisions.js';
export const name = 'typesafe-result-shaper';
export const DEFAULT_SHAPE_TOOLS = ['bash', 'pwsh', 'terminal', 'run_command', 'execute_command'];
export const DROP_MARKER = '[... %d lines dropped by TypeSafe result shaper ...]';
/** Documented defaults; `tests/docs-consistency.spec.ts` keeps README in step. */
export const DEFAULT_THRESHOLD_CHARS = 8000;
export const DEFAULT_MAX_PER_TURN = 2;
export const DEFAULT_KEEP_KINDS = ['warning', 'failure'];
export const DEFAULT_MIN_KIND_CONFIDENCE = 0.6;
export const DEFAULT_MAX_CLUSTERS = 24;
export const DEFAULT_SAMPLE_CHARS = 400;
/** The closed label set the classifier chooses from. */
export const KIND_CRITERIA = {
    routine_progress: 'Routine progress: steps completed, files processed, chunks emitted, items listed',
    summary: 'Neutral summary: totals, counts, timings, versions, a final status line',
    warning: 'A deprecation or a warning that may need attention',
    failure: 'A failure: an error code, an exception, a failed build, a failing test, a stack frame',
};
/**
 * Text of a tool result, whether it arrives as a plain string or as the block
 * array the real tools service uses. Returning undefined means there is nothing
 * textual to shape.
 */
export function extractText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return undefined;
    const parts = [];
    for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string')
            parts.push(block.text);
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
}
/**
 * Rebuild the content with the shaped text. In the block form the text blocks
 * collapse into one, and every non-text block keeps its relative position —
 * the same property DSH's own pruner preserves.
 */
export function replaceText(content, text) {
    if (typeof content === 'string')
        return text;
    if (!Array.isArray(content))
        return text;
    const rebuilt = [];
    let inserted = false;
    for (const block of content) {
        if (block && block.type === 'text') {
            if (!inserted) {
                rebuilt.push({ ...block, text });
                inserted = true;
            }
            continue;
        }
        rebuilt.push(block);
    }
    if (!inserted)
        rebuilt.push({ type: 'text', text });
    return rebuilt;
}
/** Shape of a line with numbers and hashes normalised, so variants share a key. */
export function lineShape(line) {
    return line.replace(/[0-9a-f]{6,}|\d+/gi, '#');
}
/** Group lines that differ only in numbers or hashes. */
export function clusterLines(text) {
    const byShape = new Map();
    for (const line of text.split('\n')) {
        if (line.trim().length === 0)
            continue;
        const shape = lineShape(line);
        const existing = byShape.get(shape);
        if (existing)
            existing.count += 1;
        else
            byShape.set(shape, { shape, count: 1, sample: line });
    }
    return [...byShape.values()];
}
/**
 * Cheap pre-check: is this output dominated by low-information bulk?
 *
 * Byte-identical repetition alone is too narrow: build logs, dependency trees
 * and file listings vary on every line (a counter, a path, a version) and are
 * exactly the output that fills a context window. Volume and structural
 * repetition both count, and the classifier still decides what survives.
 */
export function looksRepetitive(text) {
    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    // A few very long lines (a minified bundle, a base64 blob) qualify on their own.
    const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
    if (longest > 4000)
        return true;
    // Bulk by volume: a long listing is worth one bounded decision even when every
    // line differs.
    if (lines.length >= 120)
        return true;
    if (lines.length < 40)
        return false;
    if (uniqueRatio(lines) >= 0.25)
        return true;
    // Structurally identical lines that only differ in numbers, hashes or paths.
    return uniqueRatio(lines.map(lineShape)) >= 0.5;
}
/** Share of lines that repeat an earlier line verbatim. */
function uniqueRatio(lines) {
    return 1 - new Set(lines).size / lines.length;
}
export class ResultShaperService {
    getClient;
    config;
    shapedThisTurn = 0;
    /**
     * Set when the model kept nothing. That is the honest answer for pure noise,
     * but re-asking in the same turn would only spend another request, so the rest
     * of the turn skips shaping.
     */
    declinedThisTurn = false;
    constructor(getClient, config = {}) {
        this.getClient = getClient;
        this.config = config;
    }
    /** Reset the per-turn budget; called on each new user instruction. */
    resetTurnBudget() {
        this.shapedThisTurn = 0;
        this.declinedThisTurn = false;
    }
    shouldConsider(exec, content) {
        if (this.declinedThisTurn)
            return false;
        const tools = this.config.shapeTools ?? DEFAULT_SHAPE_TOOLS;
        if (!tools.includes(exec?.name))
            return false;
        if (content.length < (this.config.thresholdChars ?? DEFAULT_THRESHOLD_CHARS))
            return false;
        if (this.shapedThisTurn >= (this.config.maxPerTurn ?? DEFAULT_MAX_PER_TURN))
            return false;
        return looksRepetitive(content);
    }
    /**
     * Classify each distinct line shape and keep only the clusters that report a
     * warning or a failure.
     * @returns the shaped text, or undefined when shaping is not justified.
     */
    async shape(content, toolName) {
        const clusters = clusterLines(content);
        if (clusters.length < 2)
            return undefined;
        const selected = clusters.slice(0, this.config.maxClusters ?? DEFAULT_MAX_CLUSTERS);
        const questions = {};
        selected.forEach((cluster, index) => {
            // The sample travels inside its own question: referencing cluster N in the
            // state instead produced confident nonsense (docs/calibration.md §9).
            // Each item travels inside its own question. Referring to it by index in the
            // state instead produced identical or confidently wrong answers for every
            // question (docs/calibration.md §9.3); tests/question-binding.spec.ts
            // guards the property.
            questions['kind_' + index] = choice('Classify this line of tool output by kind:\n---\n' +
                cluster.sample.slice(0, this.config.sampleChars ?? DEFAULT_SAMPLE_CHARS) +
                '\n---', KIND_CRITERIA);
        });
        const started = Date.now();
        const client = this.getClient();
        const results = await client.systemOne({
            state: {
                tool: toolName,
                note: 'Each question carries one line of output; classify that line.',
                distinctLines: clusters.length,
                occurrences: selected.map((cluster) => cluster.count),
            },
            questions: questions,
        }, { timeoutMs: this.config.requestTimeoutMs ?? 4000 });
        const latencyMs = Date.now() - started;
        const keepKinds = new Set(this.config.keepKinds ?? DEFAULT_KEEP_KINDS);
        const minConfidence = this.config.minKindConfidence ?? DEFAULT_MIN_KIND_CONFIDENCE;
        const keptShapes = new Set();
        // Clusters past the cap keep their lines: the cap bounds cost, it is not a
        // licence to drop content the model never saw.
        for (const cluster of clusters.slice(selected.length))
            keptShapes.add(cluster.shape);
        selected.forEach((cluster, index) => {
            const answer = results['kind_' + index];
            if (!answer || answer.unknown) {
                keptShapes.add(cluster.shape);
                return;
            }
            const confidence = typeof answer.confidence === 'number' ? answer.confidence : 0;
            if (keepKinds.has(answer.choice) && confidence >= minConfidence)
                keptShapes.add(cluster.shape);
        });
        if (keptShapes.size === 0) {
            this.declinedThisTurn = true;
            return undefined;
        }
        let droppedLines = 0;
        const rebuilt = [];
        let runStart = -1;
        const flushRun = (endExclusive) => {
            if (runStart < 0)
                return;
            droppedLines += endExclusive - runStart;
            rebuilt.push(DROP_MARKER.replace('%d', String(endExclusive - runStart)));
            runStart = -1;
        };
        const lines = content.split('\n');
        lines.forEach((line, index) => {
            const kept = line.trim().length === 0 || keptShapes.has(lineShape(line));
            if (kept) {
                flushRun(index);
                rebuilt.push(line);
            }
            else if (runStart < 0) {
                runStart = index;
            }
        });
        flushRun(lines.length);
        const text = rebuilt.join('\n');
        if (droppedLines === 0 || text.length >= content.length)
            return undefined;
        this.shapedThisTurn += 1;
        return {
            text,
            keptClusters: keptShapes.size,
            droppedClusters: Math.max(0, clusters.length - keptShapes.size),
            droppedLines,
            latencyMs,
        };
    }
}
export function apply(ctx, config = {}) {
    const shaper = new ResultShaperService(() => resolveClientFrom(ctx), config);
    // Waterfall listener: the budget reset must not swallow the step decision.
    const unsubscribePreStep = ctx.on('agent/pre-step', (...hookArgs) => {
        const next = hookArgs[hookArgs.length - 1];
        shaper.resetTurnBudget();
        return typeof next === 'function' ? next() : undefined;
    });
    const unsubscribe = ctx.on('tools/post-execute', async (...hookArgs) => {
        let exec;
        let result;
        let next;
        if (hookArgs.length >= 3 && typeof hookArgs[2] === 'function') {
            if (hookArgs[0] && (hookArgs[0].action || hookArgs[0].kind) && hookArgs[1]?.name) {
                exec = hookArgs[1];
                result = hookArgs[0];
                next = () => Promise.resolve(hookArgs[2](hookArgs[0]));
            }
            else {
                exec = hookArgs[0];
                result = hookArgs[1];
                next = hookArgs[2];
            }
        }
        else {
            exec = hookArgs[0];
            result = hookArgs[1];
            next = typeof hookArgs[2] === 'function' ? hookArgs[2] : async () => ({ kind: 'accept', action: 'accept' });
        }
        const baseDecision = await next();
        try {
            if (!result || result.isError)
                return baseDecision;
            // The real service carries content as a block array; a string-only check
            // made this module inert in the pipeline while its unit tests passed.
            const originalText = extractText(result.content);
            if (originalText === undefined)
                return baseDecision;
            if (!shaper.shouldConsider(exec, originalText))
                return baseDecision;
            // A downstream listener already replaced the value or the content;
            // replacing either alongside it is rejected by the tools service.
            if (baseDecision && Object.hasOwn(baseDecision, 'value'))
                return baseDecision;
            if (baseDecision && Object.hasOwn(baseDecision, 'content'))
                return baseDecision;
            if (baseDecision && baseDecision.kind === 'block')
                return baseDecision;
            const shaped = await shaper.shape(originalText, exec.name);
            if (!shaped)
                return baseDecision;
            defaultMetrics.recordShape(originalText.length - shaped.text.length);
            defaultDecisionLog.append({
                module: 'result-shaper',
                action: 'shaped',
                latencyMs: shaped.latencyMs,
                detail: {
                    tool: exec.name,
                    keptClusters: shaped.keptClusters,
                    droppedClusters: shaped.droppedClusters,
                    droppedLines: shaped.droppedLines,
                    charsRemoved: originalText.length - shaped.text.length,
                },
            });
            return {
                ...baseDecision,
                kind: 'accept',
                action: 'accept',
                content: replaceText(result.content, shaped.text),
            };
        }
        catch (err) {
            // Never change what the tool returned because a decision failed.
            console.warn('[TypeSafe ResultShaper] Shaping failed, returning original content:', err);
            return baseDecision;
        }
    });
    return () => {
        unsubscribePreStep();
        unsubscribe();
    };
}
//# sourceMappingURL=result-shaper.js.map