/**
 * Client and Cordis service provider for TypeSafe AI (Jev System One model).
 * @module dsh-jev/client
 */
import { defaultMetrics } from './metrics.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';
/** Interactive timeout. Measured warm latency is 250-300ms, cold start 700-750ms. */
export const DEFAULT_TIMEOUT_MS = 2000;
/** Advisory post-execute timeout; the step must never wait on a stalled decision. */
export const DEFAULT_PATH_TIMEOUT_MS = 800;
/** Output tokens are free; input is billed at $0.042 per million tokens. */
export const INPUT_COST_PER_MILLION_TOKENS = 0.042;
/** Rough bytes-per-token used only for cost accounting, never for decisions. */
export const BYTES_PER_TOKEN = 4;
/** True inside a test runner, where a live key would make tests non-hermetic. */
export function isTestEnvironment() {
    if (typeof process === 'undefined')
        return false;
    return (process.env?.NODE_ENV === 'test' ||
        process.env?.VITEST !== undefined ||
        process.env?.NODE_TEST_CONTEXT !== undefined);
}
function resolveApiKey(explicit) {
    if (explicit && typeof explicit === 'string' && !explicit.startsWith('__jsExpr')) {
        return explicit;
    }
    // A test run must never reach the network through an ambient key.
    if (isTestEnvironment()) {
        return undefined;
    }
    if (typeof process !== 'undefined' && process.env?.TYPESAFE_API_KEY) {
        return process.env.TYPESAFE_API_KEY;
    }
    try {
        const envFile = join(homedir(), '.dsh', '.env');
        if (existsSync(envFile)) {
            const match = readFileSync(envFile, 'utf8').match(/TYPESAFE_API_KEY=([^\r\n]+)/);
            if (match?.[1])
                return match[1].trim();
        }
    }
    catch { }
    return undefined;
}
/**
 * Question helper for boolean verification.
 */
export function noul(instructions) {
    return { type: 'noul', instructions };
}
/**
 * Question helper for categorical selection.
 */
export function choice(instructions, criteria) {
    return { type: 'choice', instructions, criteria };
}
/**
 * Question helper for rubric scoring.
 */
export function score(instructions, criteria = ['Low', 'Medium', 'High']) {
    const criteriaList = Array.isArray(criteria) ? criteria : Object.values(criteria);
    return { type: 'score', instructions, criteria: criteriaList };
}
/**
 * TypeSafe AI Client.
 */
export class TypeSafeClient {
    apiKey;
    baseUrl;
    model;
    timeoutMs;
    pathTimeoutMs;
    cacheTtlMs;
    mockHandler;
    cache = new Map();
    constructor(config = {}) {
        this.apiKey = resolveApiKey(config.apiKey);
        this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
        this.model = config.model || DEFAULT_MODEL;
        this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.pathTimeoutMs = config.pathTimeoutMs ?? DEFAULT_PATH_TIMEOUT_MS;
        this.cacheTtlMs = config.cacheTtlMs ?? 30000;
        this.mockHandler = config.mockHandler;
    }
    /** Stable key for identical payloads; used only to skip duplicate round trips. */
    fingerprint(req, model) {
        return JSON.stringify([
            model,
            typeof req.state === 'string' ? req.state : JSON.stringify(req.state),
            req.questions,
        ]);
    }
    /**
     * Execute parallel questions against a single state context.
     */
    async systemOne(req, options = {}) {
        const start = Date.now();
        const model = req.model || this.model;
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        const payloadBody = JSON.stringify({
            model,
            state: typeof req.state === 'string' ? req.state : JSON.stringify(req.state),
            questions: req.questions,
        });
        const inputBytes = Buffer.byteLength(payloadBody, 'utf8');
        const estimatedCostUsd = (inputBytes / BYTES_PER_TOKEN / 1_000_000) * INPUT_COST_PER_MILLION_TOKENS;
        // 1. Identical-payload cache: repeated decisions in one session must not pay twice.
        const cacheKey = options.cache === false ? undefined : this.fingerprint(req, model);
        if (cacheKey !== undefined && this.cacheTtlMs > 0) {
            const hit = this.cache.get(cacheKey);
            if (hit && Date.now() - hit.at < this.cacheTtlMs) {
                defaultMetrics.recordCall(0, true, { inputBytes: 0, estimatedCostUsd: 0, latencyMs: 0, cacheHit: true });
                return cloneAnswers(hit.answers);
            }
        }
        // 2. If mock handler is provided, execute mock
        if (this.mockHandler) {
            try {
                const answers = this.normalizeAnswers(await this.mockHandler(req));
                defaultMetrics.recordCall(Date.now() - start, true, { inputBytes, estimatedCostUsd });
                return answers;
            }
            catch (err) {
                defaultMetrics.recordCall(Date.now() - start, false, { inputBytes, estimatedCostUsd });
                throw err;
            }
        }
        // 3. Validate API key
        if (!this.apiKey) {
            throw new Error('TypeSafe API key missing. Provide apiKey in config or set TYPESAFE_API_KEY environment variable.');
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(this.baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.apiKey}`,
                },
                body: payloadBody,
                signal: controller.signal,
            });
            if (!res.ok) {
                const errorText = await res.text().catch(() => 'Unknown error');
                throw new Error(`TypeSafe API request failed with status ${res.status}: ${errorText}`);
            }
            const data = (await res.json());
            const answers = this.normalizeAnswers(data.answers || data.results || data);
            if (cacheKey !== undefined && this.cacheTtlMs > 0) {
                this.cache.set(cacheKey, { at: Date.now(), answers });
                if (this.cache.size > 200) {
                    const oldest = this.cache.keys().next().value;
                    if (oldest !== undefined)
                        this.cache.delete(oldest);
                }
            }
            defaultMetrics.recordCall(Date.now() - start, true, { inputBytes, estimatedCostUsd });
            return cloneAnswers(answers);
        }
        catch (err) {
            defaultMetrics.recordCall(Date.now() - start, false, { inputBytes, estimatedCostUsd });
            throw err;
        }
        finally {
            clearTimeout(timer);
        }
    }
    /**
     * Preserve what the model actually returned. A missing or malformed answer stays
     * explicitly unknown; it is never coerced into a zero that reads as "safe".
     */
    normalizeAnswers(answers) {
        const normalized = {};
        for (const [k, v] of Object.entries(answers ?? {})) {
            if (!v || typeof v !== 'object') {
                normalized[k] = { type: 'noul', unknown: true };
                continue;
            }
            if (v.type === 'noul') {
                const raw = typeof v.noul === 'number' ? v.noul : typeof v.probability === 'number' ? v.probability : undefined;
                normalized[k] = raw === undefined ? { type: 'noul', unknown: true } : { type: 'noul', noul: raw, probability: raw };
                continue;
            }
            if (v.type === 'score') {
                normalized[k] =
                    typeof v.score === 'number' ? v : { ...v, score: 0, unknown: true };
                continue;
            }
            if (v.type === 'choice') {
                normalized[k] =
                    typeof v.choice === 'string'
                        ? v
                        : { ...v, choice: '', confidence: 0, unknown: true };
                continue;
            }
            normalized[k] = v;
        }
        return normalized;
    }
}
/** Probability of a noul answer, or `undefined` when nothing usable came back. */
export function noulProbability(result) {
    const r = result;
    if (!r || r.type !== 'noul' || r.unknown)
        return undefined;
    if (typeof r.noul === 'number')
        return r.noul;
    return typeof r.probability === 'number' ? r.probability : undefined;
}
/**
 * Probability mass on the highest criteria bucket, e.g. "definite dead loop".
 * Robust to the score scale: `score` is a continuous expected value in [0, n-1].
 */
export function topBucketProbability(result) {
    const r = result;
    if (!r || r.type !== 'score' || r.unknown || !r.probabilities)
        return undefined;
    let bestKey;
    for (const key of Object.keys(r.probabilities)) {
        const numeric = Number(key);
        if (!Number.isFinite(numeric))
            continue;
        if (bestKey === undefined || numeric > Number(bestKey))
            bestKey = key;
    }
    if (bestKey === undefined)
        return undefined;
    const value = r.probabilities[bestKey];
    return typeof value === 'number' ? value : undefined;
}
/** Score answer confidence, or `undefined` when the answer is unusable. */
export function scoreConfidence(result) {
    const r = result;
    if (!r || r.type !== 'score' || r.unknown)
        return undefined;
    return typeof r.confidence === 'number' ? r.confidence : undefined;
}
function cloneAnswers(answers) {
    return JSON.parse(JSON.stringify(answers));
}
/**
 * Resolve the shared client from a context.
 *
 * `provide` registers the service under `typesafe`; on hosts without that API the
 * plugin assigns `ctx.typesafe` directly, so both paths must be honoured or a
 * mock/injected client would be silently replaced by an unconfigured one.
 */
export function resolveClientFrom(ctx) {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('typesafe') : undefined;
    if (viaGet instanceof TypeSafeClient)
        return viaGet;
    try {
        if (ctx?.typesafe instanceof TypeSafeClient)
            return ctx.typesafe;
    }
    catch {
        // Cordis proxy throws when accessing undeclared property on Context without inject
    }
    return new TypeSafeClient();
}
/**
 * Cordis plugin entrypoint for TypeSafe service.
 */
export const name = 'typesafe-client';
export function apply(ctx, config = {}) {
    const client = new TypeSafeClient(config);
    if (typeof ctx.provide === 'function') {
        return ctx.provide('typesafe', client);
    }
    ctx.typesafe = client;
    return () => {
        if (ctx.typesafe === client) {
            delete ctx.typesafe;
        }
    };
}
//# sourceMappingURL=typesafe-client.js.map