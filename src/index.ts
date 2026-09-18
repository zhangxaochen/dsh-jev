/**
 * Entry point for TypeSafe AI integration suite for DeepSeek Harness (dsh).
 * @module dsh-jev
 */

import * as ClientPlugin from './client.js'
import * as LoopGuardPlugin from './loop-guard.js'
import * as SafetyGuardPlugin from './safety-guard.js'
import * as ToolPrunerPlugin from './tool-pruner.js'
import { defaultMetrics } from './metrics.js'
import type { CordisContext, TypeSafeSuiteConfig } from './types.js'

export * from './types.js'
export * from './client.js'
export * from './metrics.js'
export { apply as applyLoopGuard, name as loopGuardName } from './loop-guard.js'
export { apply as applySafetyGuard, name as safetyGuardName } from './safety-guard.js'
export { apply as applyToolPruner, name as toolPrunerName, ToolPrunerService } from './tool-pruner.js'

export const name = 'dsh-jev'

/**
 * Mount the full TypeSafe plugin suite onto a Cordis context.
 */
export function apply(ctx: CordisContext, config: TypeSafeSuiteConfig = {}) {
  const disposers: Array<() => void> = []

  // 1. Mount Client service
  const clientDisposer = ClientPlugin.apply(ctx, config.client ?? {})
  disposers.push(clientDisposer)

  // 2. Mount Loop Guard if enabled (default: true)
  if (config.loopGuard !== false) {
    const loopConfig = typeof config.loopGuard === 'object' ? config.loopGuard : {}
    const loopDisposer = LoopGuardPlugin.apply(ctx, loopConfig)
    disposers.push(loopDisposer)
  }

  // 3. Mount Safety Guard if enabled (default: true)
  if (config.safetyGuard !== false) {
    const safetyConfig = typeof config.safetyGuard === 'object' ? config.safetyGuard : {}
    const safetyDisposer = SafetyGuardPlugin.apply(ctx, safetyConfig)
    disposers.push(safetyDisposer)
  }

  // 4. Mount Tool Pruner if enabled (default: true)
  if (config.toolPruner !== false) {
    const prunerConfig = typeof config.toolPruner === 'object' ? config.toolPruner : {}
    const prunerDisposer = ToolPrunerPlugin.apply(ctx, prunerConfig)
    disposers.push(prunerDisposer)
  }

  // 5. Mount Jev Metrics tool if tools service is available
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    try {
      const toolDisposer = ctx.tools.register({
        name: 'jev_stats',
        description:
          'Display TypeSafe Jev metrics and statistics (pruned tools, saved tokens, dead loop interruptions, safety screens, System One latency).',
        parameters: {
          type: 'object',
          properties: {
            reset: {
              type: 'boolean',
              description: 'Reset all metrics to zero if true',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              markdown: { type: 'string' },
              tokensSaved: { type: 'number' },
            },
            required: ['markdown', 'tokensSaved'],
            additionalProperties: false,
          },
          render: (_args: unknown, value: any) => [
            {
              type: 'text' as const,
              text: String(value?.markdown ?? ''),
            },
          ],
        },
        async execute(args: any) {
          if (args && args.reset) {
            defaultMetrics.reset()
          }
          return {
            markdown: defaultMetrics.renderMarkdownDashboard(),
            tokensSaved: defaultMetrics.getTotalTokensSaved(),
          }
        },
        presentCall: () => ({
          card: 'generic',
          title: 'Jev Stats Dashboard',
          kind: 'other',
        }),
      })
      if (typeof toolDisposer === 'function') {
        disposers.push(toolDisposer)
      }
    } catch {
      // Ignore tool registration failure
    }
  }

  // 6. Mount web route for HTTP / RPC inspection if webServer is available
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    try {
      const routeDisposer = ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-jev/stats',
        handler: (req: any, res: any) => {
          const accept = (req.headers && req.headers.accept) || ''
          if (accept.includes('text/html')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(
              `<!DOCTYPE html><html><head><meta charset="utf-8"><title>TypeSafe Jev Stats</title><style>body{font-family:system-ui,sans-serif;padding:2rem;background:#1e1e2e;color:#cdd6f4;}pre{background:#181825;padding:1.5rem;border-radius:8px;line-height:1.6;font-size:14px;}</style></head><body><pre>${defaultMetrics.renderMarkdownDashboard()}</pre></body></html>`
            )
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(defaultMetrics.getSnapshot(), null, 2))
          }
        },
      })
      if (typeof routeDisposer === 'function') {
        disposers.push(routeDisposer)
      }
    } catch {
      // Ignore route registration collisions or unsupported contexts
    }
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      dispose()
    }
  }
}

export default {
  name,
  apply,
}
