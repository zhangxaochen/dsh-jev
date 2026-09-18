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
import { noul, noulProbability, resolveClientFrom, score, scoreConfidence, topBucketProbability, } from './typesafe-client.js';
import { defaultMetrics } from './metrics.js';
import { defaultDecisionLog } from './decisions.js';
export const name = 'typesafe-loop-guard';
/** Buckets of the stuck-severity rubric; index 2 is the "definite dead loop" bucket. */
export const STUCK_SEVERITY_CRITERIA = [
    'Normal progress or healthy exploration',
    'Marginal repeat or stagnant exploration',
    'Definite dead loop, circular failures, or unrecoverable repetition',
];
const TOP_BUCKET_INDEX = STUCK_SEVERITY_CRITERIA.length - 1;
/** Documented defaults; `tests/docs-consistency.spec.ts` keeps README in step. */
export const DEFAULT_TRIGGER_THRESHOLD = 2;
export const DEFAULT_NO_PROGRESS_THRESHOLD = 0.3;
export const DEFAULT_P_LOOP_THRESHOLD = 0.6;
export const DEFAULT_MIN_CONFIDENCE = 0.5;
export const DEFAULT_COOLDOWN_STEPS = 3;
export const DEFAULT_MAX_HISTORY = 8;
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
/**
 * The shipped stuck-trajectory rule, as a pure function.
 *
 * Exported so the benchmark drives this rule instead of a copy of it: the bench is
 * the CI gate for the loop guard, and while it reimplemented the thresholds a
 * change here would not have failed it (docs/calibration.md §13).
 */
export function evaluateStuckTrajectory(answers, thresholds) {
    const progress = noulProbability(answers.has_progress);
    const pLoop = topBucketProbability(answers.stuck_severity);
    const confidence = scoreConfidence(answers.stuck_severity);
    // An unusable answer is not evidence of a loop.
    if (progress === undefined || pLoop === undefined || confidence === undefined) {
        return { action: 'unknown' };
    }
    const madeNoProgress = progress < thresholds.noProgressThreshold;
    const definitivelyStuck = pLoop >= thresholds.pLoopThreshold;
    const confident = confidence >= thresholds.minConfidence;
    if (!madeNoProgress || !definitivelyStuck || !confident) {
        return { action: 'pass', progress, pLoop, confidence };
    }
    return { action: pLoop >= 0.85 ? 'interrupt' : 'warn', progress, pLoop, confidence };
}
export function apply(ctx, config = {}) {
    const triggerThreshold = config.triggerThreshold ?? DEFAULT_TRIGGER_THRESHOLD;
    const noProgressThreshold = config.noProgressThreshold ?? DEFAULT_NO_PROGRESS_THRESHOLD;
    const pLoopThreshold = config.pLoopThreshold ?? DEFAULT_P_LOOP_THRESHOLD;
    const minConfidence = config.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const cooldownSteps = config.cooldownSteps ?? DEFAULT_COOLDOWN_STEPS;
    const maxHistory = config.maxHistory ?? DEFAULT_MAX_HISTORY;
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
     *
     * `agent/pre-step` is a waterfall: a listener that does not delegate returns
     * `undefined` and the agent loop loses the decision it is waiting for. The
     * reset is bookkeeping, so it must always pass the chain on untouched.
     */
    const unsubscribePreStep = ctx.on('agent/pre-step', (...hookArgs) => {
        const payload = hookArgs[0];
        const next = hookArgs[hookArgs.length - 1];
        const agent = payload?.agent ?? payload;
        if (agent && typeof agent === 'object') {
            chains.delete(agent);
        }
        return typeof next === 'function' ? next() : undefined;
    });
    const unsubscribe = ctx.on('tools/post-execute', async (exec, result, next) => {
        // The host dispatches this waterfall as `(exec, result, next)`: dsh-tools
        // calls `waterfall(scope, 'tools/post-execute', exec, result, next)`. An
        // earlier version sniffed for other argument shapes, which could silently
        // misroute the arguments if an execution ever carried `kind` or `action`.
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
        // Read the state before ticking it down: decrementing first made
        // `cooldownSteps: N` suppress only N-1 steps, so the configured number did not
        // mean what it says. Every step still counts down.
        const cooling = chain.cooldown > 0;
        if (cooling)
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
        if (cooling) {
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
            const decisionStarted = Date.now();
            const evalResults = await client.systemOne({
                state,
                questions: {
                    has_progress: noul('Does the latest tool execution provide new, meaningful progress or fresh information towards solving the task?'),
                    stuck_severity: score('Rate how severely this execution sequence is stuck in a repetitive loop or stagnation without progress', STUCK_SEVERITY_CRITERIA),
                },
            }, { timeoutMs: client.pathTimeoutMs });
            const decisionLatencyMs = Date.now() - decisionStarted;
            const progressResult = evalResults.has_progress;
            const stuckResult = evalResults.stuck_severity;
            const verdict = evaluateStuckTrajectory(evalResults, { noProgressThreshold, pLoopThreshold, minConfidence });
            // The unknown branch above already returned, so these are present here.
            const progressProb = verdict.progress;
            const pLoop = verdict.pLoop;
            const confidence = verdict.confidence;
            if (verdict.action === 'unknown') {
                // Unknown answer is not evidence of a loop; stay silent and record it.
                defaultMetrics.recordDecisionError();
                defaultMetrics.recordLoopCheck('uncertain');
                defaultDecisionLog.append({
                    module: 'loop-guard',
                    action: 'unknown',
                    latencyMs: decisionLatencyMs,
                    detail: { tool: exec.name, reason: 'answer unusable' },
                });
                chain.noProgressStreak += 1;
                return next();
            }
            if (verdict.action === 'interrupt' || verdict.action === 'warn') {
                chain.noProgressStreak = 0;
                chain.cooldown = cooldownSteps;
                const outcome = verdict.action;
                defaultMetrics.recordLoopCheck(outcome);
                defaultDecisionLog.append({
                    module: 'loop-guard',
                    action: outcome,
                    latencyMs: decisionLatencyMs,
                    confidence,
                    probability: pLoop,
                    detail: { tool: exec.name, score: stuckResult?.score, progress: progressProb },
                });
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
                // `additionalContexts` is the key the tools service merges into the
                // conversation (verified against the installed 0.1.5-rc.2); `contexts`
                // is kept alongside it for hosts that read the older name. Both carry
                // the same single entry, never a duplicate of each other.
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
            chain.noProgressStreak = verdict.action === 'pass' && (progressProb ?? 1) < noProgressThreshold
                ? chain.noProgressStreak + 1
                : 0;
            defaultMetrics.recordLoopCheck('normal');
            // Negative examples matter as much as positive ones for calibration.
            defaultDecisionLog.append({
                module: 'loop-guard',
                action: 'pass',
                latencyMs: decisionLatencyMs,
                confidence,
                probability: pLoop,
                detail: { tool: exec.name, score: stuckResult?.score, progress: progressProb },
            });
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