/**
 * Agent-facing decision primitives.
 *
 * The guards decide *for* the model; these tools let the model ask a typed
 * question itself and branch on a calibrated probability instead of a
 * generated sentence. Batching is the point: one request carries every question.
 * @module dsh-jev/ask-tools
 */
import { noul, score } from './typesafe-client.js';
import { defaultDecisionLog } from './decisions.js';
/** Max candidates priced in one ranking request. */
export const MAX_RANK_CANDIDATES = 50;
function buildQuestion(input) {
    if (input.kind === 'choice') {
        const criteria = input.criteria;
        if (!criteria || Array.isArray(criteria)) {
            throw new Error('choice question "' + input.id + '" needs a criteria object of id -> description');
        }
        return { type: 'choice', instructions: input.instructions, criteria };
    }
    if (input.kind === 'score') {
        const criteria = Array.isArray(input.criteria) ? input.criteria : ['Low', 'Medium', 'High'];
        return { type: 'score', instructions: input.instructions, criteria };
    }
    return { type: 'noul', instructions: input.instructions };
}
/** Compact, JSON-safe projection of one answer. */
export function projectAnswer(id, result) {
    if (!result || result.unknown) {
        return { id, unknown: true };
    }
    if (result.type === 'noul') {
        return { id, kind: 'noul', probability: result.noul ?? result.probability };
    }
    if (result.type === 'score') {
        return {
            id,
            kind: 'score',
            score: result.score,
            confidence: result.confidence,
            probabilities: result.probabilities,
        };
    }
    return {
        id,
        kind: 'choice',
        choice: result.choice,
        confidence: result.confidence,
        probabilities: result.probabilities,
    };
}
/** Declare a tool result schema together with its transcript rendering. */
function textOutput(schemaProperties, required, pick) {
    return {
        schema: {
            type: 'object',
            properties: schemaProperties,
            required,
            additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: pick(value) }],
    };
}
/**
 * Register the decision primitives on a tools service.
 * @returns the disposers for everything it registered.
 */
export function registerJevTools(ctx, getClient) {
    const tools = (typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools);
    if (!tools || typeof tools.register !== 'function')
        return [];
    const disposers = [];
    const record = (module, action, facts, options) => {
        defaultDecisionLog.append({
            module,
            action,
            latencyMs: typeof facts.latencyMs === 'number' ? facts.latencyMs : undefined,
            confidence: typeof facts.confidence === 'number' ? facts.confidence : undefined,
            probability: typeof facts.probability === 'number' ? facts.probability : undefined,
            detail: { ...facts, cache: options.cache !== false },
        });
    };
    // ---- jev_ask: batched typed questions -----------------------------------
    try {
        const dispose = tools.register({
            name: 'jev_ask',
            description: 'Ask TypeSafe Jev typed questions about a state and get calibrated probabilities back instead of prose. ' +
                'Batch every question you have into one call: it is one round trip and the cheapest way to branch in code.',
            parameters: {
                type: 'object',
                properties: {
                    state: { type: 'string', description: 'The situation, document, diff or data the questions are about.' },
                    questions: {
                        type: 'array',
                        description: 'Typed questions answered in one request.',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                kind: { type: 'string', enum: ['noul', 'choice', 'score'] },
                                instructions: { type: 'string' },
                                criteria: {
                                    description: 'score: array of levels; choice: object of option id -> description',
                                },
                            },
                            required: ['id', 'kind', 'instructions'],
                        },
                    },
                },
                required: ['state', 'questions'],
                additionalProperties: false,
            },
            output: textOutput({ answers: { type: 'array' }, latencyMs: { type: 'number' }, text: { type: 'string' } }, ['answers', 'text'], (value) => String(value?.text ?? '')),
            async execute(args) {
                const started = Date.now();
                const questions = {};
                for (const input of (args?.questions ?? [])) {
                    questions[input.id] = buildQuestion(input);
                }
                if (Object.keys(questions).length === 0) {
                    throw new Error('jev_ask needs at least one question');
                }
                const client = getClient();
                const results = await client.systemOne({ state: args?.state ?? '', questions }, { timeoutMs: client.timeoutMs });
                const answers = Object.keys(questions).map((id) => projectAnswer(id, results[id]));
                const latencyMs = Date.now() - started;
                record('jev_ask', 'answered', { latencyMs, questions: Object.keys(questions).length }, {});
                return { answers, latencyMs, text: JSON.stringify(answers, null, 2) };
            },
            presentCall: () => ({ card: 'generic', title: 'Jev Ask', kind: 'other' }),
        });
        if (typeof dispose === 'function')
            disposers.push(dispose);
    }
    catch {
        /* a host without the tools service simply gets no primitives */
    }
    // ---- jev_rank: order candidates by a stated criterion --------------------
    try {
        const dispose = tools.register({
            name: 'jev_rank',
            description: 'Rank a bounded candidate list against a criterion with TypeSafe Jev. ' +
                'Use it to pick which file, tool, source or option to look at first, and read the per-candidate score.',
            parameters: {
                type: 'object',
                properties: {
                    state: { type: 'string', description: 'The task or question the ranking serves.' },
                    criterion: { type: 'string', description: 'What makes a candidate better, in one sentence.' },
                    candidates: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                label: { type: 'string' },
                                description: { type: 'string' },
                            },
                            required: ['id', 'label'],
                        },
                    },
                },
                required: ['criterion', 'candidates'],
                additionalProperties: false,
            },
            output: textOutput({ ranked: { type: 'array' }, latencyMs: { type: 'number' }, text: { type: 'string' } }, ['ranked', 'text'], (value) => String(value?.text ?? '')),
            async execute(args) {
                const started = Date.now();
                const candidates = (args?.candidates ?? []);
                if (candidates.length === 0)
                    throw new Error('jev_rank needs at least one candidate');
                if (candidates.length > MAX_RANK_CANDIDATES) {
                    throw new Error('jev_rank accepts at most ' + MAX_RANK_CANDIDATES + ' candidates, got ' + candidates.length);
                }
                const questions = {};
                for (const candidate of candidates) {
                    questions['rank_' + candidate.id] = score('How well does "' + candidate.label + '" (' + (candidate.description ?? 'no description') +
                        ') satisfy: ' + args.criterion + '?', ['Does not satisfy', 'Partially satisfies', 'Fully satisfies']);
                }
                const client = getClient();
                const results = await client.systemOne({ state: JSON.stringify({ context: args?.state ?? '', criterion: args.criterion }), questions }, { timeoutMs: client.timeoutMs });
                const ranked = candidates
                    .map((candidate) => {
                    const result = results['rank_' + candidate.id];
                    const isScore = result && result.type === 'score';
                    return {
                        id: candidate.id,
                        label: candidate.label,
                        score: isScore ? result.score : undefined,
                        confidence: isScore ? result.confidence : undefined,
                        unknown: !isScore || result.unknown === true,
                    };
                })
                    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
                const latencyMs = Date.now() - started;
                record('jev_rank', 'ranked', { latencyMs, candidates: candidates.length }, {});
                return { ranked, latencyMs, text: JSON.stringify(ranked, null, 2) };
            },
            presentCall: () => ({ card: 'generic', title: 'Jev Rank', kind: 'other' }),
        });
        if (typeof dispose === 'function')
            disposers.push(dispose);
    }
    catch {
        /* optional primitive */
    }
    // ---- jev_check: verify a claim against a state --------------------------
    try {
        const dispose = tools.register({
            name: 'jev_check',
            description: 'Ask TypeSafe Jev whether a claim actually holds for a given state, and branch on the probability. ' +
                'Use it for "is this requirement met", "is this diff safe", "does this evidence support X".',
            parameters: {
                type: 'object',
                properties: {
                    state: { type: 'string', description: 'The evidence: diff, output, document or data.' },
                    claim: { type: 'string', description: 'The claim to verify against the state.' },
                    threshold: { type: 'number', description: 'Probability at or above which the claim counts as holding (default 0.7).' },
                },
                required: ['state', 'claim'],
                additionalProperties: false,
            },
            output: textOutput({
                holds: { type: 'boolean' },
                probability: { type: 'number' },
                unknown: { type: 'boolean' },
                latencyMs: { type: 'number' },
                text: { type: 'string' },
            }, ['holds', 'text'], (value) => String(value?.text ?? '')),
            async execute(args) {
                const started = Date.now();
                const threshold = typeof args?.threshold === 'number' ? args.threshold : 0.7;
                const client = getClient();
                const results = await client.systemOne({
                    state: args?.state ?? '',
                    questions: {
                        holds: noul('Given the state, is the following claim supported and true: ' + String(args?.claim ?? '')),
                    },
                }, { timeoutMs: client.timeoutMs });
                const answer = results.holds;
                const probability = answer && answer.type === 'noul' ? answer.noul ?? answer.probability : undefined;
                const unknown = probability === undefined;
                const holds = !unknown && probability >= threshold;
                const latencyMs = Date.now() - started;
                record('jev_check', holds ? 'holds' : unknown ? 'unknown' : 'refuted', { latencyMs, probability }, {});
                return {
                    holds,
                    probability: probability ?? 0,
                    unknown,
                    latencyMs,
                    text: 'claim ' + (unknown ? 'undecided' : holds ? 'holds' : 'does not hold') +
                        ' (p=' + (probability ?? 'n/a') + ', threshold=' + threshold + ')',
                };
            },
            presentCall: () => ({ card: 'generic', title: 'Jev Check', kind: 'other' }),
        });
        if (typeof dispose === 'function')
            disposers.push(dispose);
    }
    catch {
        /* optional primitive */
    }
    return disposers;
}
//# sourceMappingURL=ask-tools.js.map