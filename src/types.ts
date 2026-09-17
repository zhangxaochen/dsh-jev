/**
 * Type declarations for TypeSafe AI integration and dsh plugin hooks.
 * @module dsh-plugin-typesafe/types
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
  rubric?: Record<number | string, string>
}

export type QuestionDefinition = NoulQuestion | ChoiceQuestion | ScoreQuestion

export interface NoulResult {
  type: 'noul'
  probability: number
}

export interface ChoiceResult {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  confidence: number
}

export interface ScoreResult {
  type: 'score'
  score: number
  probabilities: Record<number | string, number>
  confidence: number
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

export interface AdditionalContext {
  role: 'user' | 'system'
  source: {
    kind: 'plugin'
    plugin: string
    [key: string]: unknown
  }
  content: Array<{ type: 'text'; text: string; [key: string]: unknown }>
}

export interface PreToolDecision {
  action: 'allow' | 'deny' | 'ask'
  reason?: string
  modifiedArgs?: Record<string, unknown>
}

export interface PostToolDecision {
  action?: 'accept' | 'block' | 'replace'
  content?: unknown
  additionalContexts?: AdditionalContext[]
}

export interface ToolExecution {
  name: string
  args: Record<string, unknown>
  toolCallId?: string
  agent?: {
    id: string
    [key: string]: unknown
  }
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
  timeoutMs?: number
  mockHandler?: MockHandler
}

export interface LoopGuardConfig {
  /** Minimum consecutive calls to start semantic evaluation (default: 2) */
  triggerThreshold?: number
  /** Probability threshold below which execution is considered lacking progress (0.0 - 1.0, default: 0.3) */
  noProgressThreshold?: number
  /** Stuck severity threshold (1 - 3, default: 2) */
  stuckSeverityThreshold?: number
  /** Tool names to track. Empty array means all tools tracked. */
  include?: string[]
  /** Tool names to ignore. */
  exclude?: string[]
}

export interface SafetyGuardConfig {
  /** Risk probability threshold to block execution (0.0 - 1.0, default: 0.7) */
  blockThreshold?: number
  /** Risk probability threshold to ask for user approval (0.0 - 1.0, default: 0.4) */
  askApprovalThreshold?: number
  /** Tools considered sensitive that must be inspected (e.g. bash, terminal, run_code, write_to_file) */
  guardedTools?: string[]
}

export interface ToolPrunerConfig {
  /** Max tools to keep in active context (default: 5) */
  maxTools?: number
  /** Relevance score threshold (1 - 5, default: 3) */
  minScoreThreshold?: number
  /** Core tools that are never pruned */
  alwaysRetain?: string[]
}

export interface TypeSafeSuiteConfig {
  client?: TypeSafeClientConfig
  loopGuard?: LoopGuardConfig | boolean
  safetyGuard?: SafetyGuardConfig | boolean
  toolPruner?: ToolPrunerConfig | boolean
}
