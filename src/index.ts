/**
 * Entry point for TypeSafe AI integration suite for DeepSeek Harness (dsh).
 * @module dsh-plugin-typesafe
 */

import * as ClientPlugin from './client.js'
import * as LoopGuardPlugin from './loop-guard.js'
import * as SafetyGuardPlugin from './safety-guard.js'
import * as ToolPrunerPlugin from './tool-pruner.js'
import type { CordisContext, TypeSafeSuiteConfig } from './types.js'

export * from './types.js'
export * from './client.js'
export { apply as applyLoopGuard, name as loopGuardName } from './loop-guard.js'
export { apply as applySafetyGuard, name as safetyGuardName } from './safety-guard.js'
export { apply as applyToolPruner, name as toolPrunerName, ToolPrunerService } from './tool-pruner.js'

export const name = 'typesafe-suite'

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
