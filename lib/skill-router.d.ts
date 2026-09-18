/**
 * Semantic skill routing.
 *
 * DSH ships a growing skill catalog; loading the wrong one, or none, costs more
 * than the tool-schema pruning this plugin already does. This router names the
 * single most relevant skill for the current request and adds it to the prompt
 * as an advisory context — it never blocks a call and never removes a skill.
 * @module dsh-jev/skill-router
 */
import { type TypeSafeClient } from './typesafe-client.js';
import type { CordisContext, SkillRouterConfig, SkillSummary } from './types.js';
export declare const name = "typesafe-skill-router";
/** Only route when the catalog is big enough for routing to pay for itself. */
export declare const DEFAULT_MIN_CANDIDATES = 8;
export interface SkillCandidate {
    name: string;
    description: string;
    whenToUse?: string;
}
/** Map registry summaries onto router candidates. */
export declare function toCandidates(summaries: SkillSummary[]): SkillCandidate[];
export declare class SkillRouterService {
    private readonly getClient;
    private readonly config;
    private lastKey?;
    private lastName?;
    constructor(getClient: () => TypeSafeClient, config?: SkillRouterConfig);
    /** True when the catalog and the request both justify one semantic call. */
    shouldRoute(intent: string, summaries: SkillSummary[]): boolean;
    /**
     * Score every skill against the request and return the best one.
     * @returns the chosen skill and its score, or undefined when nothing is a fit.
     */
    route(intent: string, summaries: SkillSummary[]): Promise<{
        name: string;
        score: number;
        confidence: number;
        latencyMs: number;
    } | undefined>;
    /**
     * Decide what to inject for one turn. Keeps the last suggestion to avoid
     * repeating the same notice on every model step of a long turn.
     */
    advise(intent: string, summaries: SkillSummary[]): Promise<{
        name: string;
        text: string;
    } | undefined>;
}
export declare function apply(ctx: CordisContext, config?: SkillRouterConfig): () => void;
//# sourceMappingURL=skill-router.d.ts.map