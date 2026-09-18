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
export declare const DEFAULT_MIN_INTENT_CHARS = 12;
export declare const DEFAULT_MIN_SCORE = 1.5;
export declare const DEFAULT_MIN_CONFIDENCE = 0.5;
/**
 * Request budget for routing. Measured 2026-09-18: a catalog of 112 skills takes
 * 1.36-1.45s, which the client's 800ms advisory timeout aborted every time — the
 * router silently never advised until this was measured (docs/calibration.md §11).
 */
export declare const DEFAULT_REQUEST_TIMEOUT_MS = 4000;
/**
 * Score added when the request literally names a skill, e.g. an intent
 * containing "SWOT" for `swot-analysis`. Measured 2026-09-18: without it the
 * model ranked `company-intel` above `swot-analysis` for a request that spelled
 * the skill out. The literal match is a deterministic prior, not a veto — the
 * model's score still decides unless the two are close.
 */
export declare const DEFAULT_NAME_MATCH_BOOST = 0.6;
/**
 * Optional cap on how many skills are sent for ranking. `0` sends the whole
 * catalog, which is the safe default: the shortlist is lexical, and a request
 * whose language differs from the catalog's would lose the semantically correct
 * skill (a Chinese request against English skill descriptions ranks correctly
 * only when the model sees every candidate).
 */
export declare const DEFAULT_MAX_CANDIDATES = 0;
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
     * Bound the candidate set when a catalog is very large. Lexical and therefore
     * lossy: it is opt-in, and the catalog order is preserved in the request so the
     * prompt stays stable across turns.
     */
    private shortlist;
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