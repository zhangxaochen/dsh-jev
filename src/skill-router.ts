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
import { defaultMetrics } from './metrics.js'
import { defaultDecisionLog } from './decisions.js'
import type { CordisContext, SkillRouterConfig, SkillSummary } from './types.js'

export const name = 'typesafe-skill-router'

/** Only route when the catalog is big enough for routing to pay for itself. */
export const DEFAULT_MIN_CANDIDATES = 8
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
    if (intent.trim().length < (this.config.minIntentChars ?? 12)) return false
    const key = intentKey(intent)
    if (key === this.lastKey) return false
    this.lastKey = key
    return true
  }

  /**
   * Score every skill against the request and return the best one.
   * @returns the chosen skill and its score, or undefined when nothing is a fit.
   */
  async route(
    intent: string,
    summaries: SkillSummary[]
  ): Promise<{ name: string; score: number; confidence: number; latencyMs: number } | undefined> {
    const candidates = toCandidates(summaries)
    const questions: Record<string, unknown> = {}
    for (const candidate of candidates) {
      const detail = candidate.whenToUse ? candidate.description + ' When to use: ' + candidate.whenToUse : candidate.description
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
      { timeoutMs: client.pathTimeoutMs }
    )
    const latencyMs = Date.now() - started

    let best: { name: string; score: number; confidence: number; latencyMs: number } | undefined
    for (const candidate of candidates) {
      const result = results['skill_' + candidate.name] as any
      if (!result || result.unknown || typeof result.score !== 'number') continue
      if (!best || result.score > best.score || (result.score === best.score && (result.confidence ?? 0) > best.confidence)) {
        best = { name: candidate.name, score: result.score, confidence: result.confidence ?? 0, latencyMs }
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
    const minScore = this.config.minScore ?? 1.5
    const minConfidence = this.config.minConfidence ?? 0.5
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

      const advice = await router.advise(intent, summaries)
      if (!advice) return proceed()

      const contexts = Array.isArray(assembly.contexts) ? assembly.contexts : []
      const withoutStale = contexts.filter((entry: any) => entry?.name !== 'typesafe-skill-router')
      assembly.contexts = [...withoutStale, { name: 'typesafe-skill-router', text: advice.text }]
      return proceed()
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
