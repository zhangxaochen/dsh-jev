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
export const DEFAULT_TIMEOUT_MS = 10000;
function resolveApiKey(explicit) {
    if (explicit && typeof explicit === 'string' && !explicit.startsWith('__jsExpr')) {
        return explicit;
    }
    if (typeof process !== 'undefined' && process.env?.TYPESAFE_API_KEY) {
        return process.env.TYPESAFE_API_KEY;
    }
    if (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || process.env?.VITEST)) {
        return undefined;
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
    mockHandler;
    constructor(config = {}) {
        this.apiKey = resolveApiKey(config.apiKey);
        this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
        this.model = config.model || DEFAULT_MODEL;
        this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.mockHandler = config.mockHandler;
    }
    /**
     * Execute parallel questions against a single state context.
     */
    async systemOne(req) {
        const start = Date.now();
        // 1. If mock handler is provided, execute mock
        if (this.mockHandler) {
            try {
                const raw = await this.mockHandler(req);
                defaultMetrics.recordCall(Date.now() - start, true);
                return this.normalizeAnswers(raw);
            }
            catch (err) {
                defaultMetrics.recordCall(Date.now() - start, false);
                throw err;
            }
        }
        // 2. Validate API key
        if (!this.apiKey) {
            throw new Error('TypeSafe API key missing. Provide apiKey in config or set TYPESAFE_API_KEY environment variable.');
        }
        const payload = {
            model: req.model || this.model,
            state: typeof req.state === 'string' ? req.state : JSON.stringify(req.state),
            questions: req.questions,
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await fetch(this.baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            if (!res.ok) {
                const errorText = await res.text().catch(() => 'Unknown error');
                throw new Error(`TypeSafe API request failed with status ${res.status}: ${errorText}`);
            }
            const data = (await res.json());
            const answers = data.answers || data.results || data;
            defaultMetrics.recordCall(Date.now() - start, true);
            return this.normalizeAnswers(answers);
        }
        catch (err) {
            defaultMetrics.recordCall(Date.now() - start, false);
            throw err;
        }
        finally {
            clearTimeout(timer);
        }
    }
    normalizeAnswers(answers) {
        const normalized = {};
        for (const [k, v] of Object.entries(answers)) {
            if (v && typeof v === 'object' && v.type === 'noul') {
                const val = typeof v.noul === 'number' ? v.noul : (typeof v.probability === 'number' ? v.probability : 0);
                normalized[k] = { type: 'noul', noul: val, probability: val };
            }
            else {
                normalized[k] = v;
            }
        }
        return normalized;
    }
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