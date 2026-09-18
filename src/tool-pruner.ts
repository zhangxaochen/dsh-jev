/**
 * Dynamic tool and skill pruner using TypeSafe AI.
 * Ranks and filters tools to reduce context rot and speed up LLM inference.
 * @module dsh-jev/tool-pruner
 */

import { resolveClientFrom, score, TypeSafeClient } from './typesafe-client.js'
import { defaultMetrics, FALLBACK_CHARS_PER_TOKEN } from './metrics.js'
import type {
  CordisContext,
  ScoreResult,
  ToolDefinitionMinimal,
  ToolPrunerConfig,
} from './types.js'

export const name = 'typesafe-tool-pruner'

/** Max dynamic tools kept in context when the host mounts the suite. */
export const DEFAULT_MAX_TOOLS = 8

export const DEFAULT_ALWAYS_RETAIN = [
  'read_file',
  'write_to_file',
  'write_file',
  'edit_file',
  'str_replace_editor',
  'bash',
  'terminal',
  'pwsh',
  'run_command',
  'execute_command',
  'grep',
  'glob',
  'find_by_name',
  'view_file',
  'replace_file_content',
]

/** Minimal shape of the harness token estimator, kept structural on purpose. */
export interface TokenEstimator {
  estimateMessage?: (message: unknown) => number
}

/**
 * Price the tool schemas that were removed from the model-facing surface.
 *
 * The previous build multiplied a flat 150 tokens per tool. Here the removed
 * text is counted exactly and priced with the harness estimator when one is
 * mounted, falling back to a documented characters-per-token constant.
 */
export function measureRemovedTools(
  meter: TokenEstimator | undefined,
  prunedTools: ToolDefinitionMinimal[]
): { removedChars: number; estimatedTokens: number; tokenSource: 'tokenMeter' | 'heuristic' } {
  let removedChars = 0
  let estimatedTokens = 0
  let tokenSource: 'tokenMeter' | 'heuristic' = 'heuristic'

  for (const tool of prunedTools) {
    const text = JSON.stringify(tool)
    const chars = Array.from(text).length
    removedChars += chars

    let priced: number | undefined
    if (meter && typeof meter.estimateMessage === 'function') {
      try {
        const estimate = meter.estimateMessage({ role: 'system', content: [{ type: 'text', text }] })
        if (typeof estimate === 'number' && Number.isFinite(estimate)) {
          priced = estimate
          tokenSource = 'tokenMeter'
        }
      } catch {
        /* estimator refused this shape; fall through to the local heuristic */
      }
    }
    estimatedTokens += priced ?? Math.ceil(chars / FALLBACK_CHARS_PER_TOKEN)
  }

  return { removedChars, estimatedTokens, tokenSource }
}

export class ToolPrunerService {
  constructor(
    private readonly getClient: () => TypeSafeClient,
    private readonly config: ToolPrunerConfig & { meter?: TokenEstimator } = {}
  ) {}

  /**
   * Filter tools down to the most relevant subset for the current task context.
   */
  async pruneTools(
    userIntent: string,
    candidates: ToolDefinitionMinimal[]
  ): Promise<ToolDefinitionMinimal[]> {
    const maxTools = this.config.maxTools ?? 5
    const minScoreThreshold = this.config.minScoreThreshold ?? 2
    const alwaysRetain = this.config.alwaysRetain ?? DEFAULT_ALWAYS_RETAIN

    // If candidate set is already small, return as is
    if (candidates.length <= maxTools) {
      return candidates
    }

    const retainedTools: ToolDefinitionMinimal[] = []
    const evaluateCandidates: ToolDefinitionMinimal[] = []

    for (const tool of candidates) {
      if (alwaysRetain.includes(tool.name)) {
        retainedTools.push(tool)
      } else {
        evaluateCandidates.push(tool)
      }
    }

    // Build batch questions: one score question per candidate tool
    const questions: Record<string, any> = {}
    for (const tool of evaluateCandidates) {
      // Each item travels inside its own question. Referring to it by index in the
      // state instead produced identical or confidently wrong answers for every
      // question (docs/calibration.md §9.3); tests/question-binding.spec.ts
      // guards the property.
      questions[`score_${tool.name}`] = score(
        `How relevant is the tool "${tool.name}" (${tool.description || 'no description'}) to fulfilling the user goal: "${userIntent.slice(0, 300)}"?`,
        [
          'Irrelevant: Not needed for this task',
          'Potentially useful: Might be needed as a secondary step',
          'Highly relevant: Directly required or primary tool for this task',
        ]
      )
    }

    try {
      const client = this.getClient()
      const evalResults = await client.systemOne({
        state: { userIntent: userIntent.slice(0, 1000) },
        questions,
      })

      const scoredTools = evaluateCandidates.map((tool) => {
        const res = evalResults[`score_${tool.name}`] as ScoreResult | undefined
        return {
          tool,
          score: res?.score ?? 1,
          confidence: res?.confidence ?? 0,
        }
      })

      // Sort by score descending, then confidence descending
      scoredTools.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return b.confidence - a.confidence
      })

      // Pick top tools that meet threshold up to maxTools capacity
      const capacity = Math.max(0, maxTools - retainedTools.length)
      const selected = scoredTools
        .filter((item) => item.score >= minScoreThreshold)
        .slice(0, capacity)
        .map((item) => item.tool)

      // Emit the surviving tools in their original order. Score order would
      // reshuffle the model-facing tool block every turn, and this block sits
      // near the start of the request, so any change invalidates the reusable
      // prefix. Selection decides *which* tools survive; it must not decide
      // where they appear.
      const keep = new Set<ToolDefinitionMinimal>([...retainedTools, ...selected])
      const finalTools = candidates.filter((tool) => keep.has(tool))
      const prunedTools = evaluateCandidates.filter((item) => !selected.includes(item))
      defaultMetrics.recordPrune(
        candidates.length,
        finalTools.length,
        measureRemovedTools(this.config.meter, prunedTools)
      )
      return finalTools
    } catch (err) {
      console.warn('[TypeSafe ToolPruner] Pruning failed, returning original candidate list:', err)
      return candidates
    }
  }
}

export function apply(ctx: CordisContext, config: ToolPrunerConfig = {}) {
  function getClient(): TypeSafeClient {
    return resolveClientFrom(ctx)
  }

  // Prefer the harness estimator for pricing removed schemas; the pruner works
  // without it and falls back to the documented local constant.
  const meter: TokenEstimator | undefined =
    (typeof ctx.get === 'function' ? (ctx.get('tokenMeter') as TokenEstimator | undefined) : undefined) ??
    ((ctx as any).tokenMeter as TokenEstimator | undefined)

  const pruner = new ToolPrunerService(getClient, { ...config, meter })

  // Listen to system-prompt/assemble waterfall to prune tool schemas before model call
  const unsubscribe = typeof ctx.on === 'function'
    ? ctx.on('system-prompt/assemble', async (assembly: any, context: any, next: any) => {
        if (!assembly || !Array.isArray(assembly.tools)) {
          return typeof next === 'function' ? next() : assembly
        }
        const maxTools = config.maxTools ?? DEFAULT_MAX_TOOLS
        if (assembly.tools.length <= maxTools) {
          return typeof next === 'function' ? next() : assembly
        }

        let userIntent = ''
        if (Array.isArray(assembly.sections)) {
          userIntent = assembly.sections
            .map((s: any) => (typeof s.text === 'function' ? s.text(context) : s.text))
            .filter(Boolean)
            .join(' ')
            .slice(0, 500)
        }

        try {
          const pruned = await pruner.pruneTools(
            userIntent || 'General software engineering and tool execution task',
            assembly.tools
          )
          assembly.tools = pruned
          return typeof next === 'function' ? next() : assembly
        } catch (err) {
          console.warn('[TypeSafe ToolPruner] Waterfall pruning error, falling back:', err)
          return typeof next === 'function' ? next() : assembly
        }
      })
    : undefined

  if (typeof ctx.provide === 'function') {
    ctx.provide('toolPruner', pruner)
  } else {
    ctx.toolPruner = pruner
  }

  return () => {
    if (typeof unsubscribe === 'function') {
      unsubscribe()
    }
    if (ctx.toolPruner === pruner) {
      delete ctx.toolPruner
    }
  }
}
