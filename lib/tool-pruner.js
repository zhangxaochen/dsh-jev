/**
 * Dynamic tool and skill pruner using TypeSafe AI.
 * Ranks and filters tools to reduce context rot and speed up LLM inference.
 * @module dsh-jev/tool-pruner
 */
import { score, TypeSafeClient } from './typesafe-client.js';
import { defaultMetrics } from './metrics.js';
export const name = 'typesafe-tool-pruner';
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
            const finalTools = [...retainedTools, ...selected];
            const prunedTools = evaluateCandidates.filter((item) => !selected.includes(item));
            const prunedChars = prunedTools.reduce((acc, t) => acc + JSON.stringify(t).length, 0);
            const exactTokens = Math.max(prunedTools.length * 50, Math.round(prunedChars / 3.5));
            defaultMetrics.recordPrune(candidates.length, finalTools.length, exactTokens);
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
        const client = typeof ctx.get === 'function' ? ctx.get('typesafe') : undefined;
        if (client instanceof TypeSafeClient) {
            return client;
        }
        return new TypeSafeClient();
    }
    const pruner = new ToolPrunerService(getClient, config);
    // Listen to system-prompt/assemble waterfall to prune tool schemas before model call
    const unsubscribe = typeof ctx.on === 'function'
        ? ctx.on('system-prompt/assemble', async (assembly, context, next) => {
            if (!assembly || !Array.isArray(assembly.tools)) {
                return typeof next === 'function' ? next() : assembly;
            }
            const maxTools = config.maxTools ?? 8;
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
            try {
                const pruned = await pruner.pruneTools(userIntent || 'General software engineering and tool execution task', assembly.tools);
                assembly.tools = pruned;
                return typeof next === 'function' ? next() : assembly;
            }
            catch (err) {
                console.warn('[TypeSafe ToolPruner] Waterfall pruning error, falling back:', err);
                return typeof next === 'function' ? next() : assembly;
            }
        })
        : undefined;
    if (typeof ctx.provide === 'function') {
        ctx.provide('toolPruner', pruner);
    }
    else {
        ctx.toolPruner = pruner;
    }
    return () => {
        if (typeof unsubscribe === 'function') {
            unsubscribe();
        }
        if (ctx.toolPruner === pruner) {
            delete ctx.toolPruner;
        }
    };
}
//# sourceMappingURL=tool-pruner.js.map