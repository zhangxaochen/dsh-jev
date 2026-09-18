/**
 * Client and Cordis service provider for TypeSafe AI (Jev System One model).
 * @module dsh-jev/client
 */
import type { ChoiceQuestion, CordisContext, NoulQuestion, QuestionResult, ScoreQuestion, SystemOneRequest, TypeSafeClientConfig } from './types.js';
export declare const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1/systemone";
export declare const DEFAULT_MODEL = "jev-latest";
/** Interactive timeout. Measured warm latency is 250-300ms, cold start 700-750ms. */
export declare const DEFAULT_TIMEOUT_MS = 2000;
/** Advisory post-execute timeout; the step must never wait on a stalled decision. */
export declare const DEFAULT_PATH_TIMEOUT_MS = 800;
/** Output tokens are free; input is billed at $0.042 per million tokens. */
export declare const INPUT_COST_PER_MILLION_TOKENS = 0.042;
/** Rough bytes-per-token used only for cost accounting, never for decisions. */
export declare const BYTES_PER_TOKEN = 4;
export interface SystemOneOptions {
    /** Override the configured timeout for this call (advisory paths use `pathTimeoutMs`). */
    timeoutMs?: number;
    /** Set to false to bypass the identical-payload cache. */
    cache?: boolean;
}
/** True inside a test runner, where a live key would make tests non-hermetic. */
export declare function isTestEnvironment(): boolean;
/**
 * Question helper for boolean verification.
 */
export declare function noul(instructions: string): NoulQuestion;
/**
 * Question helper for categorical selection.
 */
export declare function choice(instructions: string, criteria: Record<string, string | null>): ChoiceQuestion;
/**
 * Question helper for rubric scoring.
 */
export declare function score(instructions: string, criteria?: string[] | Record<number | string, string>): ScoreQuestion;
/**
 * TypeSafe AI Client.
 */
export declare class TypeSafeClient {
    readonly apiKey?: string;
    readonly baseUrl: string;
    readonly model: string;
    readonly timeoutMs: number;
    readonly pathTimeoutMs: number;
    readonly cacheTtlMs: number;
    private readonly mockHandler?;
    private readonly cache;
    constructor(config?: TypeSafeClientConfig);
    /** Stable key for identical payloads; used only to skip duplicate round trips. */
    private fingerprint;
    /**
     * Execute parallel questions against a single state context.
     */
    systemOne(req: SystemOneRequest, options?: SystemOneOptions): Promise<Record<string, QuestionResult>>;
    /**
     * Preserve what the model actually returned. A missing or malformed answer stays
     * explicitly unknown; it is never coerced into a zero that reads as "safe".
     */
    private normalizeAnswers;
}
/** Probability of a noul answer, or `undefined` when nothing usable came back. */
export declare function noulProbability(result: unknown): number | undefined;
/**
 * Probability mass on the highest criteria bucket, e.g. "definite dead loop".
 * Robust to the score scale: `score` is a continuous expected value in [0, n-1].
 */
export declare function topBucketProbability(result: unknown): number | undefined;
/** Score answer confidence, or `undefined` when the answer is unusable. */
export declare function scoreConfidence(result: unknown): number | undefined;
/** Highest criteria index for a rubric of `criteriaCount` items. */
export declare function topBucketIndex(criteriaCount: number): number;
/**
 * Resolve the shared client from a context.
 *
 * `provide` registers the service under `typesafe`; on hosts without that API the
 * plugin assigns `ctx.typesafe` directly, so both paths must be honoured or a
 * mock/injected client would be silently replaced by an unconfigured one.
 */
export declare function resolveClientFrom(ctx: CordisContext): TypeSafeClient;
/**
 * Cordis plugin entrypoint for TypeSafe service.
 */
export declare const name = "typesafe-client";
export declare function apply(ctx: CordisContext, config?: TypeSafeClientConfig): any;
//# sourceMappingURL=typesafe-client.d.ts.map