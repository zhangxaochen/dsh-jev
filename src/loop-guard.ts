/**
 * Loop guard plugin for semantic loop and stagnation interception.
 * Observes tools/post-execute to detect cyclical agent behavior and prompt plan adaptation.
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
    async (...hookArgs: any[]): Promise<PostToolDecision> => {
      let exec: ToolExecution
      let result: any
      let next: () => Promise<PostToolDecision>

      if (hookArgs.length >= 3 && typeof hookArgs[2] === 'function') {
        // Distinguish between legacy test harness (decision, exec, next) vs standard DSH (exec, result, next)
        if (hookArgs[0] && (hookArgs[0].action || hookArgs[0].kind) && hookArgs[1]?.name) {
          exec = hookArgs[1]
          result = hookArgs[0]
          next = () => Promise.resolve(hookArgs[2](hookArgs[0]))
        } else {
          exec = hookArgs[0]
          result = hookArgs[1]
          next = hookArgs[2]
        }
      } else {
        exec = hookArgs[0]
        result = hookArgs[1]
        next = typeof hookArgs[2] === 'function' ? hookArgs[2] : async () => ({ kind: 'accept', action: 'accept' })
      }

      if (!shouldTrack(exec?.name)) {
        return next()
      }

      const agentKey = exec.agent?.id || 'default'
      let history = historyByAgent.get(agentKey)
      if (!history) {
        history = []
        historyByAgent.set(agentKey, history)
      }

      const contentStr = typeof result?.content === 'string'
        ? result.content
        : JSON.stringify(result?.content ?? result?.error ?? '')

      const currentRecord: StepRecord = {
        tool: exec.name,
        args: JSON.stringify(exec.args ?? {}),
        contentPreview: contentStr.slice(0, 1500),
        timestamp: Date.now(),
      }

      history.push(currentRecord)

      // Only check when history length meets triggerThreshold
      if (history.length < triggerThreshold) {
        return next()
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

          const baseDecision = await next()
          if (baseDecision && 'kind' in baseDecision && baseDecision.kind === 'block') {
            return baseDecision
          }
          const existingContexts = (baseDecision as any)?.contexts || (baseDecision as any)?.additionalContexts || []
          const newContext = {
            role: 'user' as const,
            source: {
              kind: 'plugin' as const,
              plugin: 'typesafe-loop-guard',
              form: 'notice',
              tool: exec.name,
              severity: stuckResult?.score,
            },
            content: [{ type: 'text' as const, text: reminderText }],
          }

          const decisionResult: any = {
            kind: 'accept',
            action: 'accept',
            contexts: [...existingContexts, newContext],
            additionalContexts: [...existingContexts, newContext],
          }

          if (baseDecision && typeof baseDecision === 'object') {
            if (Object.hasOwn(baseDecision, 'value') && (baseDecision as any).value !== undefined) {
              decisionResult.value = (baseDecision as any).value
            } else if (Object.hasOwn(baseDecision, 'content') && (baseDecision as any).content !== undefined) {
              decisionResult.content = (baseDecision as any).content
            }
          }

          return decisionResult
        }
      } catch (err) {
        // Loop guard fails open (safe against guard crashes)
        console.warn('[TypeSafe LoopGuard] Evaluation failed, continuing without intervention:', err)
      }

      return next()
    }
  )

  return () => {
    historyByAgent.clear()
    unsubscribe()
  }
}
