/**
 * Type declarations for TypeSafe AI integration and dsh plugin hooks.
 * @module dsh-jev/types
 */

// ==========================================
// TypeSafe AI (System One / Jev) Definitions
// ==========================================

export type QuestionType = 'noul' | 'choice' | 'score'

export interface NoulQuestion {
  type: 'noul'
  instructions: string
}

export interface ChoiceQuestion {
  type: 'choice'
  instructions: string
  criteria: Record<string, string | null>
}

export interface ScoreQuestion {
  type: 'score'
  instructions: string
  criteria: string[]
}

export type QuestionDefinition = NoulQuestion | ChoiceQuestion | ScoreQuestion

export interface NoulResult {
  type: 'noul'
  /** Raw probability in [0, 1]; `undefined` when the model returned no usable value. */
  noul?: number
  /** Derived alias of `noul`; kept for callers that read `probability`. */
  probability?: number
  /** True when the model returned no usable value for this question. */
  unknown?: boolean
}

export interface ChoiceResult {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  confidence: number
  /** True when the model returned no usable value for this question. */
  unknown?: boolean
}

export interface ScoreResult {
  type: 'score'
  /** Continuous expected value over the criteria indexes, in [0, criteria.length - 1]. */
  score: number
  probabilities: Record<string, number>
  confidence: number
  legend?: Record<string, string>
  /** True when the model returned no usable value for this question. */
  unknown?: boolean
}

export type QuestionResult = NoulResult | ChoiceResult | ScoreResult

export interface SystemOneRequest {
  state: string | Record<string, unknown>
  questions: Record<string, QuestionDefinition>
  model?: string
}

export interface SystemOneResponse {
  results: Record<string, QuestionResult>
  latencyMs?: number
}

export type MockHandler = (req: SystemOneRequest) => Promise<Record<string, QuestionResult>> | Record<string, QuestionResult>

// ==========================================
// Cordis & DSH Pipeline Hook Definitions
// ==========================================

export interface ModelContext {
  role: 'user' | 'system'
  content: Array<{ type: 'text'; text: string; [key: string]: unknown }>
  source?: {
    kind: 'plugin'
    plugin: string
    [key: string]: unknown
  }
}

export type AdditionalContext = ModelContext

export type PreToolDecision =
  | { kind: 'allow'; action?: 'allow' }
  | { kind: 'deny'; action?: 'deny'; reason: string }
  | { kind: 'ask'; action?: 'ask'; prompt?: string; reason?: string; details?: Record<string, unknown> }
  | { kind: 'cancel'; action?: 'cancel' }

export type PostToolDecision =
  | {
      kind: 'accept'
      action?: 'accept'
      content?: string
      value?: unknown
      /** Carried by dsh-jev for hosts that read the older key. */
      contexts?: readonly ModelContext[]
      /** The key the tools service merges into the conversation. */
      additionalContexts?: ModelContext[]
    }
  | { kind: 'block'; action?: 'block'; feedback: readonly string[] }

export interface ToolExecution {
  name: string
  args?: Record<string, unknown>
  arguments?: unknown
  toolCallId?: string
  agent?: {
    id: string
    [key: string]: unknown
  }
}

export interface ToolExecutionResult {
  content?: string
  error?: { message: string; [key: string]: unknown }
  [key: string]: unknown
}

export interface ToolDefinitionMinimal {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

// Minimal Cordis Context interface for typed interop
export interface CordisContext {
  on: (event: string, callback: (...args: any[]) => any) => () => void
  typesafe?: any
  tools?: {
    getTools?: () => ToolDefinitionMinimal[]
    [key: string]: any
  }
  [key: string]: any
}

// ==========================================
// Plugin Configuration Definitions
// ==========================================

export interface TypeSafeClientConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  /** Timeout for interactive requests (default: 2000ms; measured warm latency is 250-300ms). */
  timeoutMs?: number
  /** Timeout for advisory post-execute requests (default: 800ms). */
  pathTimeoutMs?: number
  /** TTL for identical-payload result caching, 0 disables (default: 30000ms). */
  cacheTtlMs?: number
  mockHandler?: MockHandler
}


export interface LoopGuardConfig {
  /** Consecutive no-progress steps before semantic evaluation starts (default: 2) */
  triggerThreshold?: number
  /** Progress probability below which a step counts as no progress (0..1, default: 0.3) */
  noProgressThreshold?: number
  /**
   * Probability mass on the "definite dead loop" bucket required to intervene (0..1, default: 0.6).
   * Measured 2026-09-18: true loop 0.86, healthy exploration 0.00, former false positives ~0.4.
   */
  pLoopThreshold?: number
  /** Minimum answer confidence required to act (0..1, default: 0.5) */
  minConfidence?: number
  /** Steps to stay silent after an intervention (default: 3) */
  cooldownSteps?: number
  /** Retained per-agent history window (default: 8) */
  maxHistory?: number
  /** Skip semantic evaluation for exact repeats; DSH's repeat-tool-reminder owns those (default: true) */
  deferExactRepeats?: boolean
  /** Tool names to track. Empty array means all tools tracked. */
  include?: string[]
  /** Tool names to ignore. */
  exclude?: string[]
}

/** One user-declared semantic safety rule. */
export interface SafetyRule {
  /** Stable id used in logs and metrics. */
  id: string
  /** Typed yes/no question asked about the tool call. */
  question: string
  /** Probability threshold above which `action` applies (0..1, default: 0.7). */
  threshold?: number
  /** Decision taken when the threshold is met (default: 'ask'). */
  action?: 'deny' | 'ask' | 'warn'
}

export interface SafetyGuardConfig {
  /** Hazard probability at or above which execution is denied (0..1, default: 0.85) */
  blockThreshold?: number
  /** Hazard probability at or above which approval is requested (0..1, default: 0.5) */
  askApprovalThreshold?: number
  /** Tools considered sensitive that must be inspected (e.g. bash, terminal, run_code, write_to_file) */
  guardedTools?: string[]
  /**
   * Decision when the semantic verdict cannot be obtained (API error, timeout, malformed answer).
   * Guarded tools fail closed by default; every other tool stays advisory.
   */
  onError?: 'deny-guarded' | 'deny-all' | 'allow'
  /**
   * Decision when an answer arrives but carries no usable probability.
   * `deny-guarded` (default) denies only the guarded tool set.
   */
  onUncertain?: 'deny-guarded' | 'deny-all' | 'allow'
  /**
   * Explicitly declare headless environment mode.
   * In headless mode DSH turns an approval request into a hard denial, so `ask` is
   * reported as `deny` for guarded tools instead of silently allowing the call.
   */
  headless?: boolean
  /** User-declared semantic rules evaluated in the same request as the built-in questions. */
  rules?: SafetyRule[]
}

/** Registry summary shape the skill router consumes (structural, host-agnostic). */
export interface SkillSummary {
  name: string
  description?: string
  whenToUse?: string
}

export interface SkillRouterConfig {
  /** Skip routing below this catalog size (default 8). */
  minCandidates?: number
  /** Skip routing for shorter requests (default 12 characters). */
  minIntentChars?: number
  /** Minimum applicability score to advise a skill, on the [0, 2] scale (default 1.5). */
  minScore?: number
  /** Minimum answer confidence to advise a skill (default 0.5). */
  minConfidence?: number
  /** Score added when the request literally names a skill (default 0.6). */
  nameMatchBoost?: number
  /** Routing request timeout; a full catalog needs seconds, not the advisory 800ms (default 4000). */
  requestTimeoutMs?: number
  /** Optional lexical cap on candidates; 0 sends the whole catalog (default 0). */
  maxCandidates?: number
}

export interface ResultShaperConfig {
  /** Tools whose textual output may be shaped (default: the output-heavy shell tools). */
  shapeTools?: string[]
  /** Only consider content at or above this many characters (default 8000). */
  thresholdChars?: number
  /** At most this many shaped results per user turn (default 2). */
  maxPerTurn?: number
  /** Kinds that survive shaping; everything else is dropped (default warning, failure). */
  keepKinds?: string[]
  /** Minimum classifier confidence to keep a cluster (default 0.6). */
  minKindConfidence?: number
  /** Upper bound on classified line shapes per request (default 24). */
  maxClusters?: number
  /** Characters of each representative line sent for classification (default 400). */
  sampleChars?: number
  /** Timeout for the classification request (default 4000ms). */
  requestTimeoutMs?: number
}
export interface ToolPrunerConfig {
  /** Max tools to keep in active context (default: 5) */
  maxTools?: number
  /** Minimum relevance score to keep a tool; measured scale is [0, 2] for the 3-level rubric (default: 2) */
  minScoreThreshold?: number
  /** Core tools that are never pruned */
  alwaysRetain?: string[]
}

export interface TypeSafeSuiteConfig {
  client?: TypeSafeClientConfig
  loopGuard?: LoopGuardConfig | boolean
  safetyGuard?: SafetyGuardConfig | boolean
  toolPruner?: ToolPrunerConfig | boolean
  /** Agent-facing decision primitives (`jev_ask`, `jev_rank`, `jev_check`), default true. */
  askTools?: boolean
  skillRouter?: SkillRouterConfig | boolean
  /**
   * Semantic shaping of oversized tool output. Off by default: it changes what
   * the model sees, so it must be an explicit opt-in per deployment.
   */
  resultShaper?: ResultShaperConfig | boolean
}
