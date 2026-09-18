/**
 * Loop guard plugin for semantic loop and stagnation interception.
 * Observes tools/post-execute to detect cyclical agent behavior and prompt plan adaptation.
 *
 * Division of labour (measured 2026-09-18, see docs/calibration.md):
 * - exact repeats of the same tool + arguments are DSH's `repeat-tool-reminder` job
 *   (thresholds 3/5/8, canonicalized arguments). This guard defers to it.
 * - this guard judges *near-identical / semantically stagnant* trajectories, and only
 *   when the answer carries enough probability mass and confidence to justify it.
 * @module dsh-jev/loop-guard
 */
import { randomUUID } from 'node:crypto';
import { noul, resolveClientFrom, score, scoreConfidence, topBucketProbability } from './typesafe-client.js';
import { defaultMetrics } from './metrics.js';
export const name = 'typesafe-loop-guard';
/** Buckets of the stuck-severity rubric; index 2 is the "definite dead loop" bucket. */
export const STUCK_SEVERITY_CRITERIA = [
    'Normal progress or healthy exploration',
    'Marginal repeat or stagnant exploration',
    'Definite dead loop, circular failures, or unrecoverable repetition',
];
const TOP_BUCKET_INDEX = STUCK_SEVERITY_CRITERIA.length - 1;
/** FNV-1a over a string; used only to detect identical outputs cheaply. */
function hashString(value) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
}
/** Canonical argument identity: key order must not create a false "new" call. */
function canonicalArgs(args) {
    const normalise = (value) => {
        if (Array.isArray(value))
            return value.map(normalise);
        if (value && typeof value === 'object') {
            const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
            return entries.map(([k, v]) => [k, normalise(v)]);
        }
        return value;
    };
    try {
        return JSON.stringify(normalise(args ?? {}));
    }
    catch {
        return String(args);
    }
}
export function apply(ctx, config = {}) {
    const triggerThreshold = config.triggerThreshold ?? 2;
    const noProgressThreshold = config.noProgressThreshold ?? 0.3;
    const pLoopThreshold = config.pLoopThreshold ?? 0.6;
    const minConfidence = config.minConfidence ?? 0.5;
    const cooldownSteps = config.cooldownSteps ?? 3;
    const maxHistory = config.maxHistory ?? 8;
    const deferExactRepeats = config.deferExactRepeats ?? true;
    const include = config.include ?? [];
    const exclude = config.exclude ?? [];
    // Keyed by the agent object so an entry dies with its agent and ids never collide.
    const chains = new WeakMap();
    function getClient() {
        return resolveClientFrom(ctx);
    }
    function shouldTrack(toolName) {
        if (exclude.includes(toolName))
            return false;
        if (include.length > 0 && !include.includes(toolName))
            return false;
        return true;
    }
    function chainFor(agent) {
        let chain = chains.get(agent);
        if (!chain) {
            chain = { history: [], noProgressStreak: 0, cooldown: 0 };
            chains.set(agent, chain);
        }
        return chain;
    }
    /**
     * Reset per-agent state on a new user instruction, matching
     * `dsh-repeat-tool-reminder`: a fresh instruction is never a loop.
     */
    const unsubscribePreStep = ctx.on('agent/pre-step', (...hookArgs) => {
        const agent = hookArgs[0]?.agent ?? hookArgs[0];
        if (agent && typeof agent === 'object') {
            chains.delete(agent);
        }
    });
    const unsubscribe = ctx.on('tools/post-execute', async (...hookArgs) => {
        let exec;
        let result;
        let next;
        if (hookArgs.length >= 3 && typeof hookArgs[2] === 'function') {
            // Distinguish between legacy test harness (decision, exec, next) vs standard DSH (exec, result, next)
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
        if (!shouldTrack(exec?.name)) {
            return next();
        }
        const agent = exec.agent && typeof exec.agent === 'object' ? exec.agent : undefined;
        if (!agent) {
            // No agent to remind; nothing to key on.
            return next();
        }
        const contentStr = typeof result?.content === 'string'
            ? result.content
            : JSON.stringify(result?.content ?? result?.error ?? '');
        const argsKey = canonicalArgs(exec.arguments ?? exec.args);
        const chain = chainFor(agent);
        if (chain.cooldown > 0)
            chain.cooldown -= 1;
        const previous = chain.history[chain.history.length - 1];
        const isExactRepeat = previous !== undefined &&
            previous.tool === exec.name &&
            previous.argsKey === argsKey &&
            previous.contentHash === hashString(contentStr);
        chain.history.push({
            tool: exec.name,
            argsKey,
            contentHash: hashString(contentStr),
            timestamp: Date.now(),
        });
        if (chain.history.length > maxHistory) {
            chain.history.splice(0, chain.history.length - maxHistory);
        }
        // Exact repeats belong to dsh-repeat-tool-reminder (thresholds 3/5/8).
        if (deferExactRepeats && isExactRepeat) {
            return next();
        }
        // Cheap shell first: only escalate to Jev once the streak is long enough.
        if (chain.noProgressStreak + 1 < triggerThreshold) {
            chain.noProgressStreak += 1;
            return next();
        }
        if (chain.cooldown > 0) {
            return next();
        }
        const recentSteps = chain.history.slice(-triggerThreshold);
        const state = {
            currentTool: exec.name,
            currentArgs: exec.arguments ?? exec.args,
            currentOutputSample: contentStr.slice(0, 1500),
            /** Bounded window size, so the cap is visible in traces and tests. */
            historyDepth: chain.history.length,
            recentTrajectory: recentSteps.map((s, idx) => ({
                step: idx + 1,
                tool: s.tool,
                args: s.argsKey.slice(0, 300),
                outputHash: s.contentHash,
            })),
        };
        try {
            const client = getClient();
            const evalResults = await client.systemOne({
                state,
                questions: {
                    has_progress: noul('Does the latest tool execution provide new, meaningful progress or fresh information towards solving the task?'),
                    stuck_severity: score('Rate how severely this execution sequence is stuck in a repetitive loop or stagnation without progress', STUCK_SEVERITY_CRITERIA),
                },
            }, { timeoutMs: client.pathTimeoutMs });
            const progressResult = evalResults.has_progress;
            const stuckResult = evalResults.stuck_severity;
            const progressProb = progressResult?.unknown
                ? undefined
                : typeof progressResult?.probability === 'number'
                    ? progressResult.probability
                    : typeof progressResult?.noul === 'number'
                        ? progressResult.noul
                        : undefined;
            const pLoop = topBucketProbability(stuckResult);
            const confidence = scoreConfidence(stuckResult);
            if (progressProb === undefined || pLoop === undefined || confidence === undefined) {
                // Unknown answer is not evidence of a loop; stay silent and record it.
                defaultMetrics.recordDecisionError();
                defaultMetrics.recordLoopCheck('normal');
                chain.noProgressStreak += 1;
                return next();
            }
            const madeNoProgress = progressProb < noProgressThreshold;
            const confident = confidence >= minConfidence;
            const definitivelyStuck = pLoop >= pLoopThreshold;
            if (madeNoProgress && definitivelyStuck && confident) {
                chain.noProgressStreak = 0;
                chain.cooldown = cooldownSteps;
                const outcome = pLoop >= 0.85 ? 'interrupt' : 'warn';
                defaultMetrics.recordLoopCheck(outcome);
                const reminderText = `[TypeSafe LoopGuard] Potential loop or stagnation detected on tool "${exec.name}". ` +
                    `Progress probability is ${(progressProb * 100).toFixed(0)}%, ` +
                    `dead-loop probability ${(pLoop * 100).toFixed(0)}% ` +
                    `(severity ${stuckResult?.score?.toFixed?.(2) ?? '?'}/${TOP_BUCKET_INDEX}, confidence ${(confidence * 100).toFixed(0)}%). ` +
                    `Please review your recent results and adjust your plan rather than repeating similar queries or unguided retries.`;
                const baseDecision = await next();
                if (baseDecision && 'kind' in baseDecision && baseDecision.kind === 'block') {
                    return baseDecision;
                }
                const existingContexts = baseDecision?.contexts || baseDecision?.additionalContexts || [];
                const newContext = {
                    id: randomUUID(),
                    role: 'user',
                    source: {
                        kind: 'plugin',
                        plugin: 'typesafe-loop-guard',
                        form: 'notice',
                        tool: exec.name,
                        severity: stuckResult?.score,
                        pLoop,
                        confidence,
                    },
                    content: [{ type: 'text', text: reminderText }],
                };
                const decisionResult = {
                    kind: 'accept',
                    action: 'accept',
                    contexts: [...existingContexts, newContext],
                    additionalContexts: [...existingContexts, newContext],
                };
                if (baseDecision && typeof baseDecision === 'object') {
                    if (Object.hasOwn(baseDecision, 'value') && baseDecision.value !== undefined) {
                        decisionResult.value = baseDecision.value;
                    }
                    else if (Object.hasOwn(baseDecision, 'content') && baseDecision.content !== undefined) {
                        decisionResult.content = baseDecision.content;
                    }
                }
                return decisionResult;
            }
            chain.noProgressStreak = madeNoProgress ? chain.noProgressStreak + 1 : 0;
            defaultMetrics.recordLoopCheck('normal');
        }
        catch (err) {
            // Advisory path: a failed decision never blocks or delays the agent.
            console.warn('[TypeSafe LoopGuard] Evaluation failed, continuing without intervention:', err);
        }
        return next();
    });
    return () => {
        unsubscribePreStep();
        unsubscribe();
    };
}
//# sourceMappingURL=loop-guard.js.map