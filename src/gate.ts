/**
 * Runtime master switch for the plugin's behaviour.
 *
 * The panel's status-bar button flips this, so a user can leave the plugin installed and
 * stop it acting without uninstalling or restarting anything. It is deliberately a plain
 * file read on every check rather than a cached flag: the check happens once per tool call
 * or prompt assembly, the file is tiny, and reading it means an external edit
 * (`echo '{"enabled":false}' > ~/.dsh/jev-enabled.json`) takes effect immediately with no
 * cache to invalidate.
 *
 * What "off" means: every module's listener delegates straight through, so the plugin
 * prunes nothing, routes nothing, shapes nothing, and - this is deliberate and documented
 * in the README - the deterministic hard-deny layer stops denying too. A master switch
 * with a hidden exception would be a surprise. The stats route and the panel keep working
 * while off, which is how the button turns it back on.
 *
 * The default when the file is absent, unreadable or malformed is **enabled**: a broken
 * switch file must never silently disable a guard.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Overrides the toggle file, so tests and scripts never touch the operator's state. */
export const GATE_PATH_ENV = 'DSH_JEV_GATE_PATH'

export interface JevGateState {
  enabled: boolean
  /** When and why it was last changed, for the panel to show. */
  changedAt?: string
  changedBy?: string
}

export function resolveGatePath(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit
  const override = typeof process !== 'undefined' ? process.env?.[GATE_PATH_ENV] : undefined
  if (override !== undefined && override.length > 0) return override
  return join(homedir(), '.dsh', 'jev-enabled.json')
}

/**
 * Whether the plugin should act.
 *
 * Any problem reading the file yields `true`: the guard layer must not be disabled by a
 * filesystem hiccup.
 */
export function isJevEnabled(explicitPath?: string): boolean {
  try {
    const path = resolveGatePath(explicitPath)
    if (!existsSync(path)) return true
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<JevGateState>
    return parsed.enabled !== false
  } catch {
    return true
  }
}

/** Full state, for the payload the panel renders. */
export function readJevGate(explicitPath?: string): JevGateState {
  try {
    const path = resolveGatePath(explicitPath)
    if (!existsSync(path)) return { enabled: true }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<JevGateState>
    return {
      enabled: parsed.enabled !== false,
      changedAt: typeof parsed.changedAt === 'string' ? parsed.changedAt : undefined,
      changedBy: typeof parsed.changedBy === 'string' ? parsed.changedBy : undefined,
    }
  } catch {
    return { enabled: true }
  }
}

/** Flip the switch and persist it. */
export function setJevEnabled(enabled: boolean, changedBy = 'panel', explicitPath?: string): JevGateState {
  const state: JevGateState = { enabled, changedAt: new Date().toISOString(), changedBy }
  const path = resolveGatePath(explicitPath)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf8')
  } catch {
    // A read-only home still gets the in-memory answer for this call; the next read
    // reports enabled, which is the safe direction.
  }
  return state
}
