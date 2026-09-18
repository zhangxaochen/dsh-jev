/**
 * Client and Cordis service provider for TypeSafe AI (Jev System One model).
 * @module dsh-jev/client
 */
import type { ChoiceQuestion, CordisContext, NoulQuestion, QuestionResult, ScoreQuestion, SystemOneRequest, TypeSafeClientConfig } from './types.js';
export declare const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1/systemone";
export declare const DEFAULT_MODEL = "jev-latest";
export declare const DEFAULT_TIMEOUT_MS = 10000;
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
    private readonly mockHandler?;
    constructor(config?: TypeSafeClientConfig);
    /**
     * Execute parallel questions against a single state context.
     */
    systemOne(req: SystemOneRequest): Promise<Record<string, QuestionResult>>;
    private normalizeAnswers;
}
/**
 * Cordis plugin entrypoint for TypeSafe service.
 */
export declare const name = "typesafe-client";
export declare function apply(ctx: CordisContext, config?: TypeSafeClientConfig): any;
//# sourceMappingURL=typesafe-client.d.ts.map