/**
 * Semantic skill routing.
 *
 * DSH ships a growing skill catalog; loading the wrong one, or none, costs more
 * than the tool-schema pruning this plugin already does. This router names the
 * single most relevant skill for the current request and adds it to the prompt
 * as an advisory context — it never blocks a call and never removes a skill.
 * @module dsh-jev/skill-router
 */

import { resolveClientFrom, score, type TypeSafeClient } from './typesafe-client.js'
import { isJevEnabled } from './gate.js'
import { defaultMetrics } from './metrics.js'
import { defaultDecisionLog } from './decisions.js'
import type { CordisContext, SkillRouterConfig, SkillSummary } from './types.js'

export const name = 'typesafe-skill-router'

/** Only route when the catalog is big enough for routing to pay for itself. */
export const DEFAULT_MIN_CANDIDATES = 8
export const DEFAULT_MIN_INTENT_CHARS = 12
export const DEFAULT_MIN_SCORE = 1.5
export const DEFAULT_MIN_CONFIDENCE = 0.5
/**
 * Request budget for routing. Measured 2026-09-18: a catalog of 112 skills takes
 * 1.36-1.45s, which the client's 800ms advisory timeout aborted every time — the
 * router silently never advised until this was measured (docs/calibration.md §11).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 4000
/**
 * Score added when the request literally names a skill, e.g. an intent
 * containing "SWOT" for `swot-analysis`. Measured 2026-09-18: without it the
 * model ranked `company-intel` above `swot-analysis` for a request that spelled
 * the skill out. The literal match is a deterministic prior, not a veto — the
 * model's score still decides unless the two are close.
 */
export const DEFAULT_NAME_MATCH_BOOST = 0.6
/**
 * Optional cap on how many skills are sent for ranking. `0` sends the whole
 * catalog, which is the safe default: the shortlist is lexical, and a request
 * whose language differs from the catalog's would lose the semantically correct
 * skill (a Chinese request against English skill descriptions ranks correctly
 * only when the model sees every candidate).
 */
export const DEFAULT_MAX_CANDIDATES = 0
const CRITERIA = [
  'Not applicable: this skill would not help with the request',
  'Possibly applicable: related but not the primary need',
  'Directly applicable: this is the skill the request should load',
]

/** Stable, cheap identity of a request so an unchanged turn is not re-routed. */
function intentKey(intent: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < intent.length; i += 1) {
    hash ^= intent.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

export interface SkillCandidate {
  name: string
  description: string
  whenToUse?: string
}

/** Map registry summaries onto router candidates. */
export function toCandidates(summaries: SkillSummary[]): SkillCandidate[] {
  return summaries.map((summary) => ({
    name: summary.name,
    description: summary.description ?? '',
    whenToUse: summary.whenToUse,
  }))
}

export class SkillRouterService {
  private lastKey?: string
  private lastName?: string

  constructor(
    private readonly getClient: () => TypeSafeClient,
    private readonly config: SkillRouterConfig = {}
  ) {}

  /** True when the catalog and the request both justify one semantic call. */
  shouldRoute(intent: string, summaries: SkillSummary[]): boolean {
    const minCandidates = this.config.minCandidates ?? DEFAULT_MIN_CANDIDATES
    if (summaries.length < minCandidates) return false
    if (intent.trim().length < (this.config.minIntentChars ?? DEFAULT_MIN_INTENT_CHARS)) return false
    const key = intentKey(intent)
    if (key === this.lastKey) return false
    this.lastKey = key
    return true
  }

  /**
   * Bound the candidate set when a catalog is very large. Lexical and therefore
   * lossy: it is opt-in, and the catalog order is preserved in the request so the
   * prompt stays stable across turns.
   */
  private shortlist(intent: string, candidates: SkillCandidate[]): SkillCandidate[] {
    const max = this.config.maxCandidates ?? DEFAULT_MAX_CANDIDATES
    if (max <= 0 || candidates.length <= max) return candidates

    const words = intent.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []
    const scored = candidates.map((candidate, index) => {
      const text = (candidate.name + ' ' + candidate.description + ' ' + (candidate.whenToUse ?? '')).toLowerCase()
      const overlap = words.reduce((count, word) => count + (text.includes(word) ? 1 : 0), 0)
      return { candidate, index, overlap }
    })
    scored.sort((a, b) => b.overlap - a.overlap || a.index - b.index)
    return scored
      .slice(0, max)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.candidate)
  }

  /**
   * Score every skill against the request and return the best one.
   * @returns the chosen skill and its score, or undefined when nothing is a fit.
   */
  async route(
    intent: string,
    summaries: SkillSummary[]
  ): Promise<{ name: string; score: number; confidence: number; latencyMs: number } | undefined> {
    const candidates = this.shortlist(intent, toCandidates(summaries))
    const questions: Record<string, unknown> = {}
    for (const candidate of candidates) {
      const detail = candidate.whenToUse ? candidate.description + ' When to use: ' + candidate.whenToUse : candidate.description
      // Each item travels inside its own question. Referring to it by index in the
      // state instead produced identical or confidently wrong answers for every
      // question (docs/calibration.md §9.3); tests/question-binding.spec.ts
      // guards the property.
      questions['skill_' + candidate.name] = score(
        'How applicable is the skill "' + candidate.name + '" (' + detail.slice(0, 400) + ') to this request: "' +
          intent.slice(0, 400) + '"?',
        CRITERIA
      )
    }

    const started = Date.now()
    const client = this.getClient()
    const results = await client.systemOne(
      { state: { request: intent.slice(0, 2000) }, questions: questions as any },
      { timeoutMs: this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS }
    )
    const latencyMs = Date.now() - started

    const boost = this.config.nameMatchBoost ?? DEFAULT_NAME_MATCH_BOOST
    const lowered = intent.toLowerCase()
    const named = new Set<string>()
    for (const candidate of candidates) {
      const tokens = candidate.name.toLowerCase().split('-').filter((token) => token.length >= 4)
      const full = candidate.name.toLowerCase()
      if (lowered.includes(full) || tokens.some((token) => lowered.includes(token))) named.add(candidate.name)
    }

    let best: { name: string; score: number; confidence: number; latencyMs: number; named: boolean } | undefined
    for (const candidate of candidates) {
      const result = results['skill_' + candidate.name] as any
      if (!result || result.unknown || typeof result.score !== 'number') continue
      const isNamed = named.has(candidate.name)
      const score = Math.min(2, result.score + (isNamed ? boost : 0))
      if (
        !best ||
        score > best.score ||
        (score === best.score && (result.confidence ?? 0) > best.confidence)
      ) {
        best = { name: candidate.name, score, confidence: result.confidence ?? 0, latencyMs, named: isNamed }
      }
    }
    return best
  }

  /**
   * Decide what to inject for one turn. Keeps the last suggestion to avoid
   * repeating the same notice on every model step of a long turn.
   */
  async advise(
    intent: string,
    summaries: SkillSummary[]
  ): Promise<{ name: string; text: string } | undefined> {
    const best = await this.route(intent, summaries)
    if (!best) return undefined
    const minScore = this.config.minScore ?? DEFAULT_MIN_SCORE
    const minConfidence = this.config.minConfidence ?? DEFAULT_MIN_CONFIDENCE
    if (best.score < minScore || best.confidence < minConfidence) {
      defaultMetrics.recordDecisionError()
      defaultDecisionLog.append({
        module: 'skill-router',
        action: 'below-threshold',
        latencyMs: best.latencyMs,
        confidence: best.confidence,
        probability: best.score,
        detail: { skill: best.name },
      })
      return undefined
    }
    if (this.lastName === best.name) return undefined
    this.lastName = best.name
    defaultDecisionLog.append({
      module: 'skill-router',
      action: 'routed',
      latencyMs: best.latencyMs,
      confidence: best.confidence,
      probability: best.score,
      detail: { skill: best.name },
    })
    return {
      name: best.name,
      text:
        '[TypeSafe SkillRouter] The skill "' + best.name + '" looks directly applicable to this request ' +
        '(score ' + best.score.toFixed(2) + '/2, confidence ' + (best.confidence * 100).toFixed(0) + '%). ' +
        'Load it if it matches what the user asked for; ignore this notice otherwise.',
    }
  }
}

export function apply(ctx: CordisContext, config: SkillRouterConfig = {}) {
  const router = new SkillRouterService(() => resolveClientFrom(ctx), config)

  const unsubscribe = ctx.on('system-prompt/assemble', async (assembly: any, _context: any, next: any) => {
    const proceed = () => (typeof next === 'function' ? next() : assembly)
    if (!isJevEnabled()) return proceed()
    try {
      if (!assembly || typeof assembly !== 'object') return proceed()
      const skills = (typeof ctx.get === 'function' ? ctx.get('skills') : (ctx as any).skills) as
        | { list?: (options?: unknown) => Promise<SkillSummary[]> }
        | undefined
      if (!skills || typeof skills.list !== 'function') return proceed()

      const summaries = await skills.list({})
      const intent = Array.isArray(assembly.sections)
        ? assembly.sections
            .map((section: any) => (typeof section?.text === 'string' ? section.text : ''))
            .filter(Boolean)
            .join(' ')
        : ''

      if (!router.shouldRoute(intent, summaries)) return proceed()

      // Start the routing call before handing the assembly downstream, so it runs
      // while the pruner makes its own call. Measured on the real assembly: the two
      // calls ran back to back (0ms -> 772ms, then 955ms -> 1908ms), so overlapping
      // them removes one whole call from the critical path of every turn without
      // adding a request (docs/calibration.md §20). The advice depends only on the
      // intent and the skill catalog, neither of which the downstream listeners touch.
      const pending = router.advise(intent, summaries).catch((err) => {
        console.warn('[TypeSafe SkillRouter] Routing failed, continuing without advice:', err)
        return undefined
      })

      const downstream = await proceed()
      const advice = await pending
      if (!advice) return downstream

      const contexts = Array.isArray(assembly.contexts) ? assembly.contexts : []
      const withoutStale = contexts.filter((entry: any) => entry?.name !== 'typesafe-skill-router')
      assembly.contexts = [...withoutStale, { name: 'typesafe-skill-router', text: advice.text }]
      return downstream
    } catch (err) {
      // Advisory only: a routing failure must never disturb prompt assembly.
      console.warn('[TypeSafe SkillRouter] Routing failed, continuing without advice:', err)
      return proceed()
    }
  })

  return () => {
    unsubscribe()
  }
}
