/**
 * Client and Cordis service provider for TypeSafe AI (Jev System One model).
 * @module dsh-plugin-typesafe/client
 */

import type {
  ChoiceQuestion,
  CordisContext,
  NoulQuestion,
  QuestionResult,
  ScoreQuestion,
  SystemOneRequest,
  TypeSafeClientConfig,
} from './types.js'

export const DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1/systemone'
export const DEFAULT_MODEL = 'jev-latest'
export const DEFAULT_TIMEOUT_MS = 10000

/**
 * Question helper for boolean verification.
 */
export function noul(instructions: string): NoulQuestion {
  return { type: 'noul', instructions }
}

/**
 * Question helper for categorical selection.
 */
export function choice(instructions: string, criteria: Record<string, string | null>): ChoiceQuestion {
  return { type: 'choice', instructions, criteria }
}

/**
 * Question helper for rubric scoring.
 */
export function score(instructions: string, rubric?: Record<number | string, string>): ScoreQuestion {
  return { type: 'score', instructions, rubric }
}

/**
 * TypeSafe AI Client.
 */
export class TypeSafeClient {
  public readonly apiKey?: string
  public readonly baseUrl: string
  public readonly model: string
  public readonly timeoutMs: number
  private readonly mockHandler?: TypeSafeClientConfig['mockHandler']

  constructor(config: TypeSafeClientConfig = {}) {
    this.apiKey = config.apiKey || (typeof process !== 'undefined' ? process.env.TYPESAFE_API_KEY : undefined)
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL
    this.model = config.model || DEFAULT_MODEL
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.mockHandler = config.mockHandler
  }

  /**
   * Execute parallel questions against a single state context.
   */
  async systemOne(req: SystemOneRequest): Promise<Record<string, QuestionResult>> {
    // 1. If mock handler is provided, execute mock
    if (this.mockHandler) {
      return this.mockHandler(req)
    }

    // 2. Validate API key
    if (!this.apiKey) {
      throw new Error(
        'TypeSafe API key missing. Provide apiKey in config or set TYPESAFE_API_KEY environment variable.'
      )
    }

    const payload = {
      model: req.model || this.model,
      state: typeof req.state === 'string' ? req.state : JSON.stringify(req.state),
      questions: req.questions,
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const res = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      if (!res.ok) {
        const errorText = await res.text().catch(() => 'Unknown error')
        throw new Error(`TypeSafe API request failed with status ${res.status}: ${errorText}`)
      }

      const data = (await res.json()) as any

      // If wrapped in results field or top level
      const results: Record<string, QuestionResult> = data.results || data
      return results
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Cordis plugin entrypoint for TypeSafe service.
 */
export const name = 'typesafe-client'

export function apply(ctx: CordisContext, config: TypeSafeClientConfig = {}) {
  const client = new TypeSafeClient(config)
  ctx.typesafe = client

  return () => {
    if (ctx.typesafe === client) {
      delete ctx.typesafe
    }
  }
}
