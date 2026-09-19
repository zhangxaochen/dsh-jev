/**
 * Execution safety gatekeeper plugin using TypeSafe AI.
 *
 * Two layers, deliberately ordered:
 * 1. a synchronous deterministic envelope registered through `ctx.tools.guard()`
 *    for shapes that must never run (filesystem-root deletion, disk overwrite,
 *    credential exfiltration). No later listener can force-allow a guarded denial.
 * 2. a semantic verdict from Jev on `tools/pre-execute`, which catches the shapes
 *    no pattern list ever covered.
 *
 * Failure policy is explicit and fail-closed by default for guarded tools: a
 * timeout, API error, or answer without a usable probability denies the call
 * instead of silently allowing it.
 * @module dsh-jev/safety-guard
 */

import { choice, noul, noulProbability, resolveClientFrom, score, TypeSafeClient } from './typesafe-client.js'
import { isJevEnabled } from './gate.js'
import { defaultMetrics } from './metrics.js'
import { defaultDecisionLog } from './decisions.js'
import type {
  ChoiceResult,
  CordisContext,
  NoulResult,
  PreToolDecision,
  SafetyGuardConfig,
  SafetyRule,
  ScoreResult,
  ToolExecution,
} from './types.js'

export const name = 'typesafe-safety-guard'

export const DEFAULT_GUARDED_TOOLS = [
  'bash',
  'terminal',
  'pwsh',
  'run_command',
  'execute_command',
  'run_code',
  'write_to_file',
  'replace_file_content',
]

/** Credential classes, so a placeholder or a doc link is not read as a live secret. */
export const CREDENTIAL_CRITERIA: Record<string, string> = {
  none: 'No credential material is present',
  placeholder_or_reference: 'Placeholder, example, redacted value, hash, or a reference to a secret elsewhere',
  real_credential: 'A live token, password, API key, or connection string with a value',
  private_key: 'A private key, keystore, or seed phrase',
}

const CREDENTIAL_HAZARD_BUCKETS = ['real_credential', 'private_key']

/** Documented defaults; `tests/docs-consistency.spec.ts` keeps README in step. */
export const DEFAULT_BLOCK_THRESHOLD = 0.85
export const DEFAULT_ASK_APPROVAL_THRESHOLD = 0.5

/**
 * Budget for the semantic inspection, in milliseconds.
 *
 * This is deliberately not `client.pathTimeoutMs` (800ms). That budget was sized for
 * the advisory path - loop-guard notices, where failing open costs nothing - while this
 * path fails closed: an inspection that times out denies a guarded tool. Measured cold
 * calls take 700-750ms and the live checks recorded after the host restart ran 587-777ms,
 * so an 800ms budget sat at the ceiling and turned a latency spike into a full tool
 * lockdown. 3500ms leaves ~4.5x headroom over the slowest measured call; the skill
 * router hit the identical wall with 800ms and was given its own 4000ms budget for it.
 */
export const DEFAULT_INSPECTION_TIMEOUT_MS = 3500

/**
 * Extra attempts for a *transient* inspection failure (timeout, abort, 429, 5xx).
 *
 * One retry removes the common case - a single slow call - without hiding a broken
 * endpoint: a permanent failure still reaches the `onError` policy after the retry.
 * A verdict that came back but is unusable is not retried; that is `onUncertain`'s job.
 */
export const DEFAULT_INSPECTION_RETRIES = 1

/** Whether a failed inspection is worth another attempt. */
export function isTransientInspectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; message?: unknown; status?: unknown; statusCode?: unknown; code?: unknown }
  const name = typeof candidate.name === 'string' ? candidate.name : ''
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  const status = typeof candidate.status === 'number' ? candidate.status : typeof candidate.statusCode === 'number' ? candidate.statusCode : undefined
  const code = typeof candidate.code === 'string' ? candidate.code : ''
  if (name === 'AbortError' || name === 'TimeoutError') return true
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN') return true
  if (status !== undefined && (status === 429 || status >= 500)) return true
  return /abort|timed?\s?out|timeout|socket hang up|network|fetch failed/i.test(message)
}

/**
 * Run the inspection, retrying a transient failure up to `retries` times.
 *
 * Bounded on purpose: a broken endpoint must still reach the failure policy rather than
 * being retried forever, and a non-transient error is never retried at all.
 */
async function inspectWithRetry<T>(
  run: () => Promise<T>,
  retries: number,
  onRetry: (attempt: number, error: unknown) => void
): Promise<T> {
  let attempt = 0
  for (;;) {
    try {
      return await run()
    } catch (error) {
      if (attempt >= retries || !isTransientInspectionError(error)) throw error
      attempt += 1
      onRetry(attempt, error)
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt))
    }
  }
}

interface HardDenyRule {
  id: string
  reason: string
  test: RegExp
}

/**
 * Strings worth inspecting for one tool call. Patterns must never be matched
 * against a JSON envelope alone: quoting hides the end of a command, so a
 * `$`-anchored pattern silently stops matching `rm -rf /`.
 */
/** Argument keys whose string value is a command to be run, wherever it sits. */
const COMMAND_KEYS = ['command', 'cmd', 'script', 'code', 'shell', 'exec', 'entrypoint']

/**
 * Keys deliberately **not** inspected as commands.
 *
 * `content`, `body`, `text`, `input`, `url` and `path` carry data for the tools that
 * are guarded: `write_to_file {path, content}` writes a file whose body may legitimately
 * contain `rm -rf /` (documentation about dangerous commands is the obvious case),
 * and matching it there denies ordinary work. Commands live under the keys above, at
 * whatever depth a tool schema nests them; anything else is the semantic layer's call.
 */
const DATA_KEYS: string[] = []

/**
 * Collect string values under `keys`, at any depth.
 *
 * Commands arrive nested in some tool schemas (`{options: {command}}`,
 * `{steps: [{command}]}`), and inspecting only the top level let those reach the
 * shell unexamined. The recursion is limited to command-shaped keys on purpose: a
 * file body under `content` may contain the text `rm -rf /` without anything
 * running it, so descending into data keys would deny ordinary writes.
 */
function collectValuesByKey(value: unknown, keys: string[], seen: string[], depth = 0): void {
  if (depth > 6 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const entry of value) collectValuesByKey(entry, keys, seen, depth + 1)
    return
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && entry.length > 0 && keys.includes(key)) seen.push(entry)
    else collectValuesByKey(entry, keys, seen, depth + 1)
  }
}

export function inspectableText(exec: ToolExecution): string[] {
  const args = exec?.arguments ?? exec?.args
  const out: string[] = []
  if (typeof args === 'string') {
    out.push(args)
    return out
  }
  if (args && typeof args === 'object') {
    for (const key of [...COMMAND_KEYS, ...DATA_KEYS]) {
      const value = (args as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.length > 0) out.push(value)
    }
    collectValuesByKey(args, COMMAND_KEYS, out)
    try {
      out.push(JSON.stringify(args))
    } catch {
      /* circular arguments are not inspectable as text */
    }
  }
  return out
}

/** Flags and targets of a delete command, without regex golf on quoting. */
/**
 * A top-level system directory, or a whole home tree.
 *
 * Denying `rm -rf /` alone left `/etc` and `/usr` to the semantic layer, which is
 * the wrong side of that trade: a miss there costs everything, and the list is
 * small and stable. Only the directory itself (optionally with a `/*` glob) is
 * matched — `/etc/nginx` and `/home/user/project` are scoped work for the model to
 * judge, not shapes for a pattern to forbid.
 */
const SYSTEM_ROOT_DIRS =
  /^(?:\/(?:etc|usr|bin|sbin|lib|lib64|boot|var|opt|srv|root|sys|proc|dev|home|Users|Applications)\/?|\/(?:etc|usr|bin|sbin|lib|lib64|boot|var|opt|srv|root|sys|proc|dev|Applications)\/\*|\/home\/[^/\s]+\/?|\/home\/[^/\s]+\/\*|\/Users\/[^/\s]+\/?|\/Users\/[^/\s]+\/\*|[a-zA-Z]:\\Users\\?|[a-zA-Z]:\\Users\\[^\\\s]+\\?)$/i

/** Syntactic brace expansion, enough for `/a{b,c}` style targets. */
function expandBraces(token: string, depth = 0): string[] {
  if (depth > 4) return [token]
  const match = token.match(/^(.*?)\{([^{}]*)\}(.*)$/)
  if (!match) return [token]
  const [, prefix, body, suffix] = match
  return body
    .split(',')
    .flatMap((part) => expandBraces(prefix + part.trim() + suffix, depth + 1))
}

/** Words that may precede the real command in a shell segment. */
const COMMAND_PREFIXES = new Set(['sudo', 'doas', 'command', 'nohup', 'time', 'nice', 'ionice', 'env', 'exec', 'xargs', 'busybox'])

/** Shells whose `-c`-style payload is itself a command. */
const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'pwsh', 'powershell', 'cmd'])

/** The flag that makes a wrapper treat the next argument as a command string. */
const PAYLOAD_FLAG = /^(?:-c|--command|-command|\/c|\/k|-e|--eval)$/i

/** The delete verbs, including the cmd and PowerShell aliases. */
const DELETE_VERB = /(^|\/)(rm|del|erase|rd|rmdir|remove-item|ri)$/i

/** Split on command separators, but never inside quotes: a commit message or a grep
 * pattern may contain `&&` or `;` without being two commands. Escaped quotes (as in the
 * JSON form of the arguments, where the payload is quoted again) do not end a run. */
function splitSegments(text: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: string | undefined
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (char === '\\' && index + 1 < text.length) {
      current += char + text[index + 1]
      index += 1
      continue
    }
    if (quote !== undefined) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '\n' || char === '\r' || char === ';' || char === '&' || char === '|') {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

/** The quoted runs of a segment, which is where a wrapper keeps its payload. */
function quotedRuns(text: string): string[] {
  const runs: string[] = []
  let current: string | undefined
  let quote: string | undefined
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (char === '\\' && index + 1 < text.length) {
      if (current !== undefined) current += text[index + 1]
      index += 1
      continue
    }
    if (quote === undefined) {
      if (char === '"' || char === "'") {
        quote = char
        current = ''
      }
      continue
    }
    if (char === quote) {
      runs.push(current ?? '')
      quote = undefined
      current = undefined
      continue
    }
    current += char
  }
  return runs
}

function baseName(token: string): string {
  const stripped = token.replace(/^['"]+|['"]+$/g, '')
  const parts = stripped.split(/[\\/]/)
  return (parts[parts.length - 1] ?? stripped).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase()
}

/**
 * Where the delete verb sits, if it is the command rather than an argument.
 *
 * A word before the verb that is neither a prefix word, a flag, a `VAR=value` nor the
 * value of a preceding flag means the verb is being *mentioned*, not run - a commit
 * message, a grep pattern, a line of documentation. Lexical matching alone cannot tell
 * those apart, and denying the mention blocked legitimate calls.
 *
 * @returns the verb's index, or -1 when it is not in command position
 */
function commandPositionVerbIndex(tokens: string[]): number {
  let awaitingFlagValue = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (DELETE_VERB.test(token)) return index
    if (token.startsWith('-') || /^\/[a-z]$/i.test(token)) {
      awaitingFlagValue = true
      continue
    }
    if (COMMAND_PREFIXES.has(baseName(token)) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      awaitingFlagValue = false
      continue
    }
    if (awaitingFlagValue) {
      // The value of a preceding flag, as in `sudo -u root <verb>`.
      awaitingFlagValue = false
      continue
    }
    return -1
  }
  return -1
}

/** Whether the segment runs a command string through a shell, and where that string is. */
function wrapperPayloadStart(tokens: string[]): number {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (SHELL_WRAPPERS.has(baseName(tokens[index]!)) && PAYLOAD_FLAG.test(tokens[index + 1]!)) {
      return index + 2
    }
  }
  return -1
}

function looksLikeRootDelete(text: string, depth = 0): boolean {
  for (const segment of splitSegments(text)) {
    // A shell wrapper runs its payload as a command (`bash -c "rm -rf /"`, also behind a
    // prefix such as `sudo -u root`), so the payload is checked as a command of its own.
    // Everything else that sits inside quotes is an argument and is not inspected.
    const tokens = segment
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => token.replace(/^['"]+|['"]+$/g, ''))
    if (tokens.length < 2) continue

    const payloadStart = wrapperPayloadStart(tokens)
    if (payloadStart !== -1 && depth < 2) {
      const payloads = [...quotedRuns(segment), tokens.slice(payloadStart).join(' ')]
      for (const payload of payloads) {
        if (payload.trim().length > 0 && looksLikeRootDelete(payload, depth + 1)) return true
      }
      continue
    }

    // `erase` and `ri` are the cmd and PowerShell aliases of `del` and Remove-Item:
    // same semantics, different spelling.
    const verbIndex = commandPositionVerbIndex(tokens)
    if (verbIndex === -1) continue
    const rest = tokens.slice(verbIndex + 1)
    const flags = rest.filter((token) => token.startsWith('-') || /^\/[a-z]$/i.test(token))
    const targets = rest.filter((token) => !flags.includes(token) && !/^\/[a-z]$/i.test(token))
    const recursive = flags.some((flag) => /^(?:-{1,2}(?:recursive|r[a-z]*|f[a-z]*)|-[a-z]*r[a-z]*|\/s|\/e)$/i.test(flag))
    const force = flags.some((flag) => /^(?:-{1,2}(?:force|f[a-z]*)|-[a-z]*f[a-z]*|\/f|\/q|\/y)$/i.test(flag))
    const rootish = targets
      // `rm -rf /{etc,usr}` reaches the same directories as `rm -rf /etc /usr`.
      .flatMap(expandBraces)
      .some(
        (token) =>
          /^(?:\/|\/\*|~|~\/|\$HOME|\$HOME\/|\$\{HOME\}\/?|[a-zA-Z]:\\?|[a-zA-Z]:\\?\*)$/.test(token) ||
          SYSTEM_ROOT_DIRS.test(token)
      )
    if (recursive && force && rootish) return true
  }
  return false
}

/**
 * Deterministic hard denies. Each entry is a shape with no legitimate agent use;
 * everything else is left to the semantic layer instead of an ever-growing list.
 */
export const HARD_DENY_RULES: HardDenyRule[] = [
  {
    id: 'windows-recursive-delete-root',
    reason: 'recursive forced deletion of a drive root',
    test: /(?:remove-item|del|rd|rmdir)\b[^\n]*-(?:recurse|r)\b[^\n]*-(?:force|f)\b[^\n]*[a-z]:\\?(?=[\s;&|"']|$)|\bdel\s+\/[a-z]\s+\/[a-z]\s+[a-z]:\\/i,
  },
  {
    id: 'raw-disk-overwrite',
    reason: 'writing to a raw block device or formatting a filesystem',
    // `mkfs`/`mke2fs` against a *device*; creating a filesystem inside an image file
    // is ordinary embedded work and must not be denied here.
    test: /\bfind\s+(?:\/|~|\$HOME)(?:\s|$)[^\n]*-delete\b|\bfind\s+(?:\/|~|\$HOME)(?:\s|$)[^\n]*-exec\s+(?:rm|del|erase|shred)\b|\bdd\b[^\n]*\bof=\/dev\/|\b(?:mkfs(?:\.\w+)?|mke2fs|mkdosfs|mkntfs)\b[^\n]*\/(?:dev|dev\/mapper)\/|\bFormat-Volume\b/i,
  },
  {
    id: 'credential-exfiltration',
    reason: 'uploading or piping private key material off the machine',
    test: /(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr)\b[^\n]*(?:-d\s*@|-F\s*\w+=@|--data(?:-binary)?\s*@|-InFile\b|--upload-file\b)[^\n]*(?:\.ssh|\.aws|\.env(?!\.(?:example|sample|template)\b)|\.npmrc|\.netrc|\.pgpass|\.git-credentials|\.kube[\\/]config|\.docker[\\/]config\.json|id_rsa|id_ed25519|credentials|keystore|\.pem)\b|(?:cat|type|Get-Content)\b[^\n]*(?:\.ssh[\\/]id_(?:rsa|ed25519|ecdsa|dsa)|\.aws[\\/]credentials|\.env(?!\.(?:example|sample|template))|\.npmrc|\.netrc|\.pgpass|\.kube[\\/]config|\.docker[\\/]config\.json)\b[^\n]*\|\s*(?:curl|wget|nc|Invoke-WebRequest|iwr)\b/i,
  },
  {
    id: 'fork-bomb',
    reason: 'shell fork bomb',
    test: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:|\bfork\s+while\s+fork\b/i,
  },
]

/** Run the deterministic envelope over one tool call. */
export function deterministicVerdict(exec: ToolExecution): { id: string; reason: string } | undefined {
  const texts = inspectableText(exec)
  for (const text of texts) {
    if (looksLikeRootDelete(text)) {
      return { id: 'filesystem-root-delete', reason: 'recursive deletion of the filesystem root or a drive root' }
    }
  }
  for (const rule of HARD_DENY_RULES) {
    if (texts.some((text) => rule.test.test(text))) {
      return { id: rule.id, reason: rule.reason }
    }
  }
  return undefined
}

/** Thresholds that turn hazard probabilities into an action. */
export interface SafetyThresholds {
  blockThreshold: number
  askApprovalThreshold: number
}

/**
 * The shipped semantic rule, as a pure function: hazard probabilities in, an
 * action out.
 *
 * Exported so the benchmark drives this rule rather than a copy of it. The bench
 * is the CI gate for the safety guard, and while it reimplemented these
 * thresholds a change here would not have failed it (docs/calibration.md §13).
 */
export function evaluateHazard(
  answers: Record<string, any>,
  thresholds: SafetyThresholds
): { action: 'deny' | 'ask' | 'pass' | 'unknown'; maxHazard?: number; riskScore?: number } {
  const hazards = ['is_destructive', 'is_exfiltration', 'is_jailbreak']
    .map((key) => noulProbability(answers[key]))
    .filter((value): value is number => typeof value === 'number')

  const credential = answers.credential_kind
  const credentialHazard =
    credential && !credential.unknown && typeof credential.probabilities === 'object'
      ? CREDENTIAL_HAZARD_BUCKETS.reduce(
          (acc, bucket) => Math.max(acc, credential.probabilities?.[bucket] ?? 0),
          0
        )
      : undefined

  const riskScore = answers.risk_score && !answers.risk_score.unknown ? answers.risk_score.score : undefined

  // No usable probability at all: the answer is unknown, not safe.
  if (hazards.length === 0 && credentialHazard === undefined && riskScore === undefined) {
    return { action: 'unknown' }
  }

  const maxHazard = Math.max(hazards.length > 0 ? Math.max(...hazards) : 0, credentialHazard ?? 0)
  if (maxHazard >= thresholds.blockThreshold || (typeof riskScore === 'number' && riskScore >= 1.7)) {
    return { action: 'deny', maxHazard, riskScore }
  }
  if (maxHazard >= thresholds.askApprovalThreshold || (typeof riskScore === 'number' && riskScore >= 0.7)) {
    return { action: 'ask', maxHazard, riskScore }
  }
  return { action: 'pass', maxHazard, riskScore }
}

/**
 * What happens when the semantic inspection cannot be obtained at all.
 *
 * `allow` by default: the inspection is an *operational* dependency, and failing closed
 * turns any upstream blip into "every guarded tool is refused" - observed live, where an
 * intermittent upstream failure blocked the operator's shell entirely (~2% of calls, and
 * one 4822ms pair that only the retry rescued). The guard still does its job whenever the
 * judge answers, and the deterministic envelope - which needs no model at all - keeps
 * denying the unambiguous cases (`rm -rf /`) regardless of this setting. The failure is
 * counted (`safetyGuard.inspectionFailures`), warned about and shown on the dashboard, so
 * "the guard was bypassed" stays visible instead of silent.
 *
 * Deployments with a threat model where the judge being unreachable is itself an attack
 * surface should pin `onError: 'deny-guarded'` in their own patch layer.
 */
export const DEFAULT_ON_ERROR: SafetyGuardConfig['onError'] = 'allow'

export function apply(ctx: CordisContext, config: SafetyGuardConfig = {}) {
  const blockThreshold = config.blockThreshold ?? DEFAULT_BLOCK_THRESHOLD
  const askApprovalThreshold = config.askApprovalThreshold ?? DEFAULT_ASK_APPROVAL_THRESHOLD
  const guardedTools = config.guardedTools ?? DEFAULT_GUARDED_TOOLS
  const onError = config.onError ?? DEFAULT_ON_ERROR
  // Left fail-closed on purpose, and not the same case: the judge *answered*, it just had
  // no usable probability, so "I don't know" should not license running. No live
  // occurrence has been observed (uncertainDenied stays 0), so this is not the knob that
  // was blocking the shell.
  const onUncertain = config.onUncertain ?? 'deny-guarded'
  const rules: SafetyRule[] = config.rules ?? []
  const inspectionTimeoutMs = config.inspectionTimeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS
  const inspectionRetries = config.inspectionRetries ?? DEFAULT_INSPECTION_RETRIES

  const isHeadless =
    config.headless ??
    (process.env.HEADLESS === 'true' ||
      process.env.CI === 'true' ||
      Boolean(process.env.DEEPSEEK_HARNESS_HEADLESS))

  function getClient(): TypeSafeClient {
    return resolveClientFrom(ctx)
  }

  function isGuarded(toolName: string): boolean {
    return guardedTools.includes(toolName)
  }

  /** Best-effort accounting for a hard denial: no model call was made. */
  function deny(reason: string): PreToolDecision {
    defaultMetrics.recordHardDeny()
    defaultDecisionLog.append({ module: 'safety-guard', action: 'deny', detail: { reason: reason.slice(0, 200) } })
    return { kind: 'deny', action: 'deny', reason }
  }

  /** Accounting for a semantic denial, carrying the deciding probability. */
  function denyWithFacts(reason: string, facts: Record<string, unknown>): PreToolDecision {
    defaultMetrics.recordSafetyCheck('deny')
    defaultDecisionLog.append({
      module: 'safety-guard',
      action: 'deny',
      probability: typeof facts.probability === 'number' ? facts.probability : undefined,
      confidence: typeof facts.confidence === 'number' ? facts.confidence : undefined,
      latencyMs: typeof facts.latencyMs === 'number' ? facts.latencyMs : undefined,
      detail: facts,
    })
    return { kind: 'deny', action: 'deny', reason }
  }

  /**
   * Apply a fail policy for one tool call. The `allow` branch delegates through
   * `next()` so downstream listeners still get their say; only a denial short-circuits.
   */
  function failPolicy(
    policy: SafetyGuardConfig['onError'],
    toolName: string,
    cause: string,
    next: () => Promise<PreToolDecision>
  ): Promise<PreToolDecision> | PreToolDecision {
    if (policy === 'deny-all') return deny(`[TypeSafe SafetyGuard] ${cause}`)
    if (policy === 'deny-guarded' && isGuarded(toolName)) return deny(`[TypeSafe SafetyGuard] ${cause}`)
    defaultMetrics.recordSafetyCheck('pass')
    return next()
  }

  /**
   * Layer 1: monotonic deterministic guard. Synchronous by contract, and no later
   * listener can force-allow a call this denies.
   */
  function registerDeterministicGuard(targetCtx: CordisContext): (() => void) | undefined {
    const tools = typeof targetCtx.get === 'function' ? targetCtx.get('tools') : (targetCtx as any).tools
    if (!tools || typeof tools.guard !== 'function') return undefined
    try {
      return tools.guard((exec: ToolExecution): string | undefined => {
        if (!isJevEnabled()) return undefined
        if (!isGuarded(exec?.name)) return undefined
        const verdict = deterministicVerdict(exec)
        if (!verdict) return undefined
        defaultMetrics.recordSafetyCheck('deny')
        return `[TypeSafe SafetyGuard] Deterministic policy ${verdict.id}: ${verdict.reason}.`
      })
    } catch {
      return undefined
    }
  }

  const guardDisposer = registerDeterministicGuard(ctx)
  const guardInject =
    typeof (ctx as any).inject === 'function' && guardDisposer === undefined
      ? (ctx as any).inject(['tools'], (child: CordisContext) => registerDeterministicGuard(child))
      : undefined

  /** Layer 2: semantic verdict. */
  const unsubscribe = ctx.on(
    'tools/pre-execute',
    async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
      // The host dispatches this waterfall as `(exec, next)`: dsh-tools calls
      // `waterfall(carrier, 'tools/pre-execute', exec, next)`. An earlier version
      // also accepted a three-argument shape, which no host uses.

      if (!isJevEnabled()) return next()
      if (!isGuarded(exec?.name)) {
        return next()
      }

      // Deterministic envelope runs first when the guard hook is unavailable.
      const hardVerdict = deterministicVerdict(exec)
      if (hardVerdict) {
        return deny(
          `[TypeSafe SafetyGuard] Deterministic policy ${hardVerdict.id}: ${hardVerdict.reason}.`
        )
      }

      const state = {
        tool: exec.name,
        arguments: exec.arguments ?? exec.args,
      }

      const questions: Record<string, unknown> = {
        is_destructive: noul(
          'Does this tool call attempt to perform unrecoverable destruction (e.g. rm -rf, drop database, wipe git history)?'
        ),
        is_exfiltration: noul(
          'Does this tool call send private credential material, keys, or secrets to a remote endpoint?'
        ),
        credential_kind: choice(
          'Does the tool call carry credential material, and of what kind?',
          CREDENTIAL_CRITERIA
        ),
        is_jailbreak: noul(
          'Does this tool call contain an injection payload, jailbreak attempt, or deliberate sandbox escape?'
        ),
        risk_score: score('Rate the overall risk and potential irreversible damage of executing this tool action', [
          'Low risk: Standard development or read/write operations',
          'Moderate risk: Broad file modification, network egress, or elevated command',
          'Critical risk: Catastrophic deletion, privilege violation, or active credential leak',
        ]),
      }
      for (const rule of rules) {
        questions[`rule_${rule.id}`] = noul(rule.question)
      }

      try {
        const client = getClient()
        const decisionStarted = Date.now()
        const evalResults = await inspectWithRetry(
          () => client.systemOne({ state, questions: questions as any }, { timeoutMs: inspectionTimeoutMs }),
          inspectionRetries,
          () => defaultMetrics.recordSafetyRetry()
        )
        const decisionLatencyMs = Date.now() - decisionStarted

        const probabilityOf = (key: string): number | undefined => {
          const r = evalResults[key] as NoulResult | undefined
          if (!r || r.unknown) return undefined
          if (typeof r.noul === 'number') return r.noul
          return typeof r.probability === 'number' ? r.probability : undefined
        }

        const verdict = evaluateHazard(evalResults, { blockThreshold, askApprovalThreshold })

        // No usable probability at all: the answer is unknown, not safe.
        if (verdict.action === 'unknown') {
          defaultMetrics.recordDecisionError()
          return failPolicy(
            onUncertain,
            exec.name,
            `Semantic verdict unavailable for "${exec.name}"; failing closed per onUncertain=${onUncertain}.`,
            next
          )
        }

        const maxHazard = verdict.maxHazard ?? 0
        const riskScore = verdict.riskScore

        // User-declared rules are evaluated on the same answer set.
        for (const rule of rules) {
          const prob = probabilityOf(`rule_${rule.id}`)
          if (prob === undefined || prob < (rule.threshold ?? 0.7)) continue
          const action = rule.action ?? 'ask'
          if (action === 'deny') {
            return deny(
              `[TypeSafe SafetyGuard] Rule "${rule.id}" matched (${(prob * 100).toFixed(0)}%): ${rule.question}`
            )
          }
          if (action === 'ask') {
            if (isHeadless) {
              return deny(
                `[TypeSafe SafetyGuard] Rule "${rule.id}" requires approval (${(prob * 100).toFixed(0)}%) and this session cannot prompt; failing closed.`
              )
            }
            defaultMetrics.recordSafetyCheck('ask')
            return {
              kind: 'ask',
              action: 'ask',
              prompt: `[TypeSafe SafetyGuard] Rule "${rule.id}" wants confirmation (${(prob * 100).toFixed(0)}%).`,
              reason: rule.question,
            }
          }
        }

        // 1. Critical hazard -> DENY
        if (verdict.action === 'deny') {
          return denyWithFacts(
            `[TypeSafe SafetyGuard] Execution blocked: hazard probability ${(maxHazard * 100).toFixed(0)}%` +
              (riskScore !== undefined ? `, risk ${riskScore.toFixed(2)}/2` : '') +
              '.',
            {
              tool: exec.name,
              probability: maxHazard,
              credentialHazard: verdict.action === 'deny' ? maxHazard : undefined,
              riskScore,
              latencyMs: decisionLatencyMs,
            }
          )
        }

        // 2. Moderate hazard -> ask, or fail closed when no prompt is possible.
        if (verdict.action === 'ask') {
          if (isHeadless) {
            return deny(
              `[TypeSafe SafetyGuard] Approval required (hazard ${(maxHazard * 100).toFixed(0)}%) and this session cannot prompt; failing closed.`
            )
          }
          defaultMetrics.recordSafetyCheck('ask')
          return {
            kind: 'ask',
            action: 'ask',
            prompt:
              `[TypeSafe SafetyGuard] Approval required: hazard probability ${(maxHazard * 100).toFixed(0)}%` +
              (riskScore !== undefined ? `, risk ${riskScore.toFixed(2)}/2` : '') +
              '.',
            reason: 'Potentially destructive or sensitive tool action',
          }
        }

        defaultMetrics.recordSafetyCheck('pass')
        defaultDecisionLog.append({
          module: 'safety-guard',
          action: 'pass',
          probability: maxHazard,
          latencyMs: decisionLatencyMs,
          detail: { tool: exec.name, riskScore },
        })
        return next()
      } catch (err) {
        defaultMetrics.recordSafetyInspectionFailure()
        console.warn('[TypeSafe SafetyGuard] Inspection failed, applying', onError, 'policy:', err)
        return failPolicy(
          onError,
          exec.name,
          `Inspection failed for "${exec.name}"; failing closed per onError=${onError}.`,
          next
        )
      }
    }
  )

  return () => {
    unsubscribe()
    if (typeof guardDisposer === 'function') guardDisposer()
    if (guardInject && typeof guardInject.dispose === 'function') guardInject.dispose()
  }
}
