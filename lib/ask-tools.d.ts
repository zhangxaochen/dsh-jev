/**
 * Agent-facing decision primitives.
 *
 * The guards decide *for* the model; these tools let the model ask a typed
 * question itself and branch on a calibrated probability instead of a
 * generated sentence. Batching is the point: one request carries every question.
 * @module dsh-jev/ask-tools
 */
import { TypeSafeClient } from './typesafe-client.js';
import type { CordisContext, QuestionResult } from './types.js';
/** Minimal tools service surface this module needs. */
export interface ToolsService {
    register: (tool: unknown) => unknown;
}
/** Max candidates priced in one ranking request. */
export declare const MAX_RANK_CANDIDATES = 50;
export interface AskQuestionInput {
    id: string;
    kind: 'noul' | 'choice' | 'score';
    instructions: string;
    criteria?: string[] | Record<string, string>;
}
/** Compact, JSON-safe projection of one answer. */
export declare function projectAnswer(id: string, result: QuestionResult | undefined): Record<string, unknown>;
/**
 * Register the decision primitives on a tools service.
 * @returns the disposers for everything it registered.
 */
export declare function registerJevTools(ctx: CordisContext, getClient: () => TypeSafeClient): Array<() => void>;
//# sourceMappingURL=ask-tools.d.ts.map