/**
 * Semantic loop and stall detection guard plugin using TypeSafe AI.
 * Intercepts tools/post-execute to detect stagnation and inject advisory context.
 * @module dsh-plugin-typesafe/loop-guard
 */

import { noul, score, TypeSafeClient } from './client.js'
import type {
  CordisContext,
  LoopGuardConfig,
  NoulResult,
  PostToolDecision,
  ScoreResult,
  ToolExecution,
} from './types.js'

export const name = 'typesafe-loop-guard'

interface StepRecord {
  tool: string
  args: string
  contentPreview: string
  timestamp: number
}

export function apply(ctx: CordisContext, config: LoopGuardConfig = {}) {
  const triggerThreshold = config.triggerThreshold ?? 2
  const noProgressThreshold = config.noProgressThreshold ?? 0.3
  const stuckSeverityThreshold = config.stuckSeverityThreshold ?? 2
  const include = config.include ?? []
  const exclude = config.exclude ?? []

  // Track execution history per agent or session
  const historyByAgent = new Map<string, StepRecord[]>()

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

  function shouldTrack(toolName: string): boolean {
    if (exclude.includes(toolName)) return false
    if (include.length > 0 && !include.includes(toolName)) return false
    return true
  }

  const unsubscribe = ctx.on(
    'tools/post-execute',
    async (
      decision: PostToolDecision,
      exec: ToolExecution,
      next: (d: PostToolDecision) => Promise<PostToolDecision> | PostToolDecision
    ) => {
      if (!shouldTrack(exec.name)) {
        return next(decision)
      }

      const agentKey = exec.agent?.id || 'default'
      let history = historyByAgent.get(agentKey)
      if (!history) {
        history = []
        historyByAgent.set(agentKey, history)
      }

      const contentStr = typeof decision.content === 'string'
        ? decision.content
        : JSON.stringify(decision.content ?? '')

      const currentRecord: StepRecord = {
        tool: exec.name,
        args: JSON.stringify(exec.args ?? {}),
        contentPreview: contentStr.slice(0, 1500),
        timestamp: Date.now(),
      }

      history.push(currentRecord)

      // Only check when history length meets triggerThreshold
      if (history.length < triggerThreshold) {
        return next(decision)
      }

      // Prepare state context describing recent tool history
      const recentSteps = history.slice(-triggerThreshold)
      const state = {
        currentTool: exec.name,
        currentArgs: exec.args,
        currentOutputSample: currentRecord.contentPreview,
        recentTrajectory: recentSteps.map((s, idx) => ({
          step: idx + 1,
          tool: s.tool,
          args: s.args,
          outputPreview: s.contentPreview.slice(0, 300),
        })),
      }

      try {
        const client = getClient()
        const evalResults = await client.systemOne({
          state,
          questions: {
            has_progress: noul(
              'Does the latest tool execution provide new, meaningful progress or fresh information towards solving the task?'
            ),
            stuck_severity: score(
              'Rate how severely this execution sequence is stuck in a repetitive loop or stagnation without progress',
              [
                'Normal progress or healthy exploration',
                'Marginal repeat or stagnant exploration',
                'Definite dead loop, circular failures, or unrecoverable repetition',
              ]
            ),
          },
        })

        const progressResult = evalResults.has_progress as NoulResult | undefined
        const stuckResult = evalResults.stuck_severity as ScoreResult | undefined

        const progressProb = progressResult ? (progressResult.probability ?? progressResult.noul) : 1
        const hasProgress = progressProb >= noProgressThreshold
        const scoreVal = stuckResult?.score ?? 0
        const isSeverelyStuck = scoreVal >= (stuckSeverityThreshold > 1.5 ? 1.4 : stuckSeverityThreshold)

        if (!hasProgress && isSeverelyStuck) {
          const confidenceInfo = stuckResult?.confidence ? ` (confidence: ${(stuckResult.confidence * 100).toFixed(0)}%)` : ''
          const reminderText =
            `[TypeSafe LoopGuard] Potential loop or stagnation detected on tool "${exec.name}". ` +
            `Evaluated progress probability is only ${(progressResult?.probability ?? 0) * 100}%, ` +
            `and stall severity is rated ${stuckResult?.score}/3${confidenceInfo}. ` +
            `Please review your recent results and adjust your plan rather than repeating similar queries or unguided retries.`

          const updatedContexts = [
            ...(decision.additionalContexts ?? []),
            {
              role: 'user' as const,
              source: {
                kind: 'plugin' as const,
                plugin: 'typesafe-loop-guard',
                form: 'notice',
                tool: exec.name,
                severity: stuckResult?.score,
              },
              content: [{ type: 'text' as const, text: reminderText }],
            },
          ]

          return next({
            ...decision,
            additionalContexts: updatedContexts,
          })
        }
      } catch (err) {
        // Loop guard fails open (safe against guard crashes)
        console.warn('[TypeSafe LoopGuard] Evaluation failed, continuing without intervention:', err)
      }

      return next(decision)
    }
  )

  return () => {
    historyByAgent.clear()
    unsubscribe()
  }
}
