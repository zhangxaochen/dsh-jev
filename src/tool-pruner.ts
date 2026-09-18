/**
 * Dynamic tool and skill pruner using TypeSafe AI.
 * Ranks and filters tools to reduce context rot and speed up LLM inference.
 * @module dsh-jev/tool-pruner
 */

import { score, TypeSafeClient } from './client.js'
import type {
  CordisContext,
  ScoreResult,
  ToolDefinitionMinimal,
  ToolPrunerConfig,
} from './types.js'

export const name = 'typesafe-tool-pruner'

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

export class ToolPrunerService {
  constructor(
    private readonly getClient: () => TypeSafeClient,
    private readonly config: ToolPrunerConfig = {}
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

      return [...retainedTools, ...selected]
    } catch (err) {
      console.warn('[TypeSafe ToolPruner] Pruning failed, returning original candidate list:', err)
      return candidates
    }
  }
}

export function apply(ctx: CordisContext, config: ToolPrunerConfig = {}) {
  function getClient(): TypeSafeClient {
    if (ctx.typesafe instanceof TypeSafeClient) {
      return ctx.typesafe
    }
    if (typeof ctx.get === 'function') {
      const client = ctx.get('typesafe')
      if (client instanceof TypeSafeClient) {
        return client
      }
    }
    return new TypeSafeClient()
  }

  const pruner = new ToolPrunerService(getClient, config)

  if (typeof ctx.provide === 'function') {
    return ctx.provide('toolPruner', pruner)
  }

  ctx.toolPruner = pruner
  return () => {
    if (ctx.toolPruner === pruner) {
      delete ctx.toolPruner
    }
  }
}
