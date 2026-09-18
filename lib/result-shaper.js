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
import { noul, resolveClientFrom } from './typesafe-client.js';
import { defaultMetrics } from './metrics.js';
import { defaultDecisionLog } from './decisions.js';
export const name = 'typesafe-result-shaper';
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
export const DEFAULT_SHAPE_TOOLS = [
    'bash',
    'pwsh',
    'terminal',
    'run_command',
    'execute_command',
];
export const DROP_MARKER = '[... %d lines dropped by TypeSafe result shaper ...]';
/** Documented defaults; `tests/docs-consistency.spec.ts` keeps README in step. */
export const DEFAULT_THRESHOLD_CHARS = 8000;
export const DEFAULT_MAX_PER_TURN = 2;
export const DEFAULT_LINES_PER_SEGMENT = 40;
export const DEFAULT_MAX_SEGMENTS = 24;
export const DEFAULT_KEEP_THRESHOLD = 0.5;
/** Group lines into contiguous segments so one question covers a coherent block. */
export function segmentText(text, linesPerSegment, maxSegments) {
    const lines = text.split('\n');
    const raw = [];
    for (let index = 0; index < lines.length; index += linesPerSegment) {
        raw.push(lines.slice(index, index + linesPerSegment).join('\n'));
    }
    if (raw.length <= maxSegments)
        return raw;
    // Coalesce evenly so the cap holds without discarding the tail.
    const perSegment = Math.ceil(raw.length / maxSegments);
    const merged = [];
    for (let index = 0; index < raw.length; index += perSegment) {
        merged.push(raw.slice(index, index + perSegment).join('\n'));
    }
    return merged;
}
/** Cheap pre-check: is this output repetitive enough that shaping can pay off? */
export function looksRepetitive(text) {
    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    // A few very long lines (a minified bundle, a base64 blob) qualify on their own.
    const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
    if (longest > 4000)
        return true;
    if (lines.length < 40)
        return false;
    const unique = new Set(lines);
    return 1 - unique.size / lines.length >= 0.25;
}
export class ResultShaperService {
    getClient;
    config;
    shapedThisTurn = 0;
    constructor(getClient, config = {}) {
        this.getClient = getClient;
        this.config = config;
    }
    /** Reset the per-turn budget; called on each new user instruction. */
    resetTurnBudget() {
        this.shapedThisTurn = 0;
    }
    shouldConsider(exec, content) {
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
     * Keep the segments Jev judges still informative, drop the rest.
     * @returns the shaped text, or undefined when shaping is not justified.
     */
    async shape(content, toolName) {
        const segments = segmentText(content, this.config.linesPerSegment ?? DEFAULT_LINES_PER_SEGMENT, this.config.maxSegments ?? DEFAULT_MAX_SEGMENTS);
        if (segments.length < 3)
            return undefined;
        const questions = {};
        segments.forEach((_segment, index) => {
            questions['keep_' + index] = noul('Does this block of command output still carry information a developer needs ' +
                '(errors, results, counts, decisions, paths), rather than repetitive noise that can be dropped?');
        });
        const started = Date.now();
        const client = this.getClient();
        const results = await client.systemOne({
            state: {
                tool: toolName,
                note: 'Output is split into ordered blocks; decide per block whether to keep it.',
                blocks: segments.map((segment, index) => ({ index, text: segment.slice(0, 1500) })),
            },
            questions: questions,
        }, { timeoutMs: client.pathTimeoutMs });
        const latencyMs = Date.now() - started;
        const keep = segments.map((_segment, index) => {
            const answer = results['keep_' + index];
            if (!answer || answer.unknown)
                return true; // unknown keeps content
            const probability = typeof answer.noul === 'number' ? answer.noul : answer.probability;
            return typeof probability !== 'number' ? true : probability >= (this.config.keepThreshold ?? DEFAULT_KEEP_THRESHOLD);
        });
        const keptSegments = keep.filter(Boolean).length;
        const droppedSegments = keep.length - keptSegments;
        // Shaping must be a clear win: keep at least the informative part and drop real volume.
        if (droppedSegments === 0 || keptSegments === 0)
            return undefined;
        let droppedLines = 0;
        const rebuilt = [];
        let runStart = -1;
        const flushRun = (endExclusive) => {
            if (runStart < 0)
                return;
            const lines = segments.slice(runStart, endExclusive).join('\n').split('\n').length;
            droppedLines += lines;
            rebuilt.push(DROP_MARKER.replace('%d', String(lines)));
            runStart = -1;
        };
        keep.forEach((keepIt, index) => {
            if (keepIt) {
                flushRun(index);
                rebuilt.push(segments[index]);
            }
            else if (runStart < 0) {
                runStart = index;
            }
        });
        flushRun(keep.length);
        const text = rebuilt.join('\n');
        if (text.length >= content.length)
            return undefined;
        this.shapedThisTurn += 1;
        return { text, droppedSegments, keptSegments, latencyMs };
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
            // A downstream listener already replaced the value; content replacement
            // alongside it is rejected by the tools service.
            if (baseDecision && Object.hasOwn(baseDecision, 'value'))
                return baseDecision;
            // Another listener already rewrote the content; do not clobber its decision.
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
                    keptSegments: shaped.keptSegments,
                    droppedSegments: shaped.droppedSegments,
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