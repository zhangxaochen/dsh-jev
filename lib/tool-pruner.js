/**
 * Dynamic tool and skill pruner using TypeSafe AI.
 * Ranks and filters tools to reduce context rot and speed up LLM inference.
 * @module dsh-jev/tool-pruner
 */
import { resolveClientFrom, score } from './typesafe-client.js';
import { defaultMetrics, FALLBACK_CHARS_PER_TOKEN } from './metrics.js';
export const name = 'typesafe-tool-pruner';
/** Max dynamic tools kept in context when the host mounts the suite. */
export const DEFAULT_MAX_TOOLS = 8;
/**
 * Fewest tools to leave in place. The threshold asks for "highly relevant" tools,
 * which measured as a single tool on a 12-tool surface; this floor keeps the agent
 * able to act when a deployment narrows `alwaysRetain` (docs/calibration.md §12).
 */
export const DEFAULT_MIN_KEEP = 3;
/**
 * Shortest usable goal. Below this the ranking has nothing to work from, and the
 * measured behaviour with an empty goal was unstable tool removal, so the pruner
 * leaves the surface alone instead.
 */
export const DEFAULT_MIN_INTENT_CHARS = 8;
export const DEFAULT_ALWAYS_RETAIN = [
    'read_file',
    'write_to_file',
    'write_file',
    'edit_file',
    'str_replace_editor',
    'bash',
    'terminal',
    'pwsh',
    'run_command',
    'execute_command',
    'grep',
    'glob',
    'find_by_name',
    'view_file',
    'replace_file_content',
];
/**
 * Price the tool schemas that were removed from the model-facing surface.
 *
 * The previous build multiplied a flat 150 tokens per tool. Here the removed
 * text is counted exactly and priced with the harness estimator when one is
 * mounted, falling back to a documented characters-per-token constant.
 */
export function measureRemovedTools(meter, prunedTools) {
    let removedChars = 0;
    let estimatedTokens = 0;
    let tokenSource = 'heuristic';
    for (const tool of prunedTools) {
        const text = JSON.stringify(tool);
        const chars = Array.from(text).length;
        removedChars += chars;
        let priced;
        if (meter && typeof meter.estimateMessage === 'function') {
            try {
                const estimate = meter.estimateMessage({ role: 'system', content: [{ type: 'text', text }] });
                if (typeof estimate === 'number' && Number.isFinite(estimate)) {
                    priced = estimate;
                    tokenSource = 'tokenMeter';
                }
            }
            catch {
                /* estimator refused this shape; fall through to the local heuristic */
            }
        }
        estimatedTokens += priced ?? Math.ceil(chars / FALLBACK_CHARS_PER_TOKEN);
    }
    return { removedChars, estimatedTokens, tokenSource };
}
export class ToolPrunerService {
    getClient;
    config;
    constructor(getClient, config = {}) {
        this.getClient = getClient;
        this.config = config;
    }
    /**
     * Filter tools down to the most relevant subset for the current task context.
     */
    async pruneTools(userIntent, candidates) {
        const maxTools = this.config.maxTools ?? 5;
        const minScoreThreshold = this.config.minScoreThreshold ?? 2;
        const alwaysRetain = this.config.alwaysRetain ?? DEFAULT_ALWAYS_RETAIN;
        // If candidate set is already small, return as is
        if (candidates.length <= maxTools) {
            return candidates;
        }
        // Without a goal there is nothing to rank against, and pruning anyway spends a
        // request to remove tools on the strength of noise: measured with an empty
        // intent, the same candidate list kept `deploy_service` for a repository task
        // and dropped `run_tests`, varying between runs (docs/calibration.md §12).
        if (userIntent.trim().length < (this.config.minIntentChars ?? DEFAULT_MIN_INTENT_CHARS)) {
            return candidates;
        }
        const retainedTools = [];
        const evaluateCandidates = [];
        for (const tool of candidates) {
            if (alwaysRetain.includes(tool.name)) {
                retainedTools.push(tool);
            }
            else {
                evaluateCandidates.push(tool);
            }
        }
        // Build batch questions: one score question per candidate tool
        const questions = {};
        for (const tool of evaluateCandidates) {
            // Each item travels inside its own question. Referring to it by index in the
            // state instead produced identical or confidently wrong answers for every
            // question (docs/calibration.md §9.3); tests/question-binding.spec.ts
            // guards the property.
            questions[`score_${tool.name}`] = score(`How relevant is the tool "${tool.name}" (${tool.description || 'no description'}) to fulfilling the user goal: "${userIntent.slice(0, 300)}"?`, [
                'Irrelevant: Not needed for this task',
                'Potentially useful: Might be needed as a secondary step',
                'Highly relevant: Directly required or primary tool for this task',
            ]);
        }
        try {
            const client = this.getClient();
            const evalResults = await client.systemOne({
                state: { userIntent: userIntent.slice(0, 1000) },
                questions,
            });
            const scoredTools = evaluateCandidates.map((tool) => {
                const res = evalResults[`score_${tool.name}`];
                return {
                    tool,
                    score: res?.score ?? 1,
                    confidence: res?.confidence ?? 0,
                };
            });
            // Sort by score descending, then confidence descending
            scoredTools.sort((a, b) => {
                if (b.score !== a.score)
                    return b.score - a.score;
                return b.confidence - a.confidence;
            });
            // Pick top tools that meet threshold up to maxTools capacity
            const capacity = Math.max(0, maxTools - retainedTools.length);
            const selected = scoredTools
                .filter((item) => item.score >= minScoreThreshold)
                .slice(0, capacity)
                .map((item) => item.tool);
            // Floor: keep the agent able to act.
            //
            // The threshold asks for tools the model rates "highly relevant", and for a
            // multi-step intent that can be a single tool — measured on a 12-tool surface
            // with the shipped threshold, "research the competitors and write a PRD" kept
            // only search_web and "fix the tests then commit" only run_tests. When a
            // deployment narrows `alwaysRetain`, the surface can reach zero tools, which
            // is a capability loss rather than a context saving. Top up from the best
            // remaining candidates instead.
            const minKeep = Math.max(0, this.config.minKeep ?? DEFAULT_MIN_KEEP);
            if (selected.length < Math.min(minKeep, capacity)) {
                for (const item of scoredTools) {
                    if (selected.length >= Math.min(minKeep, capacity))
                        break;
                    if (!selected.includes(item.tool))
                        selected.push(item.tool);
                }
            }
            // Emit the surviving tools in their original order. Score order would
            // reshuffle the model-facing tool block every turn, and this block sits
            // near the start of the request, so any change invalidates the reusable
            // prefix. Selection decides *which* tools survive; it must not decide
            // where they appear.
            const keep = new Set([...retainedTools, ...selected]);
            const finalTools = candidates.filter((tool) => keep.has(tool));
            const prunedTools = evaluateCandidates.filter((item) => !selected.includes(item));
            defaultMetrics.recordPrune(candidates.length, finalTools.length, measureRemovedTools(this.config.meter, prunedTools));
            return finalTools;
        }
        catch (err) {
            console.warn('[TypeSafe ToolPruner] Pruning failed, returning original candidate list:', err);
            return candidates;
        }
    }
}
export function apply(ctx, config = {}) {
    function getClient() {
        return resolveClientFrom(ctx);
    }
    // Prefer the harness estimator for pricing removed schemas; the pruner works
    // without it and falls back to the documented local constant.
    let meter = typeof ctx.get === 'function' ? ctx.get('tokenMeter') : undefined;
    if (!meter) {
        try {
            meter = ctx?.tokenMeter;
        }
        catch {
            // Cordis proxy throws on undeclared service property access
        }
    }
    const pruner = new ToolPrunerService(getClient, { ...config, meter });
    // Listen to system-prompt/assemble waterfall to prune tool schemas before model call
    const unsubscribe = typeof ctx.on === 'function'
        ? ctx.on('system-prompt/assemble', async (assembly, context, next) => {
            if (!assembly || !Array.isArray(assembly.tools)) {
                return typeof next === 'function' ? next() : assembly;
            }
            const maxTools = config.maxTools ?? DEFAULT_MAX_TOOLS;
            if (assembly.tools.length <= maxTools) {
                return typeof next === 'function' ? next() : assembly;
            }
            let userIntent = '';
            if (Array.isArray(assembly.sections)) {
                userIntent = assembly.sections
                    .map((s) => (typeof s.text === 'function' ? s.text(context) : s.text))
                    .filter(Boolean)
                    .join(' ')
                    .slice(0, 500);
            }
            // Start the ranking before handing the assembly downstream so it overlaps the
            // listeners that follow: this one runs first, so awaiting here would make every
            // later decision wait for it. Measured on the real assembly the two calls ran
            // back to back (0ms -> 772ms, then 955ms -> 1908ms), so the overlap removes one
            // call from the critical path of every turn at no extra cost
            // (docs/calibration.md §20).
            const candidates = assembly.tools;
            const pending = pruner
                .pruneTools(userIntent || 'General software engineering and tool execution task', candidates)
                .catch((err) => {
                console.warn('[TypeSafe ToolPruner] Waterfall pruning error, falling back:', err);
                return undefined;
            });
            const downstream = await (typeof next === 'function' ? next() : assembly);
            const pruned = await pending;
            // Only apply if nothing downstream replaced the list we ranked.
            if (pruned && assembly.tools === candidates)
                assembly.tools = pruned;
            return downstream;
        })
        : undefined;
    let provideDisposer;
    if (typeof ctx.provide === 'function') {
        provideDisposer = ctx.provide('toolPruner', pruner);
    }
    else {
        ctx.toolPruner = pruner;
    }
    return () => {
        if (typeof unsubscribe === 'function') {
            unsubscribe();
        }
        if (typeof provideDisposer === 'function') {
            provideDisposer();
        }
        else {
            try {
                if (ctx.toolPruner === pruner) {
                    delete ctx.toolPruner;
                }
            }
            catch { }
        }
    };
}
//# sourceMappingURL=tool-pruner.js.map