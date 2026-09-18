/**
 * Semantic result shaping for oversized tool output.
 *
 * DSH already caps oversized results twice, both model-free and both blind to
 * meaning: `dsh-spill-policy` keeps a head/tail preview at result time, and
 * `dsh-compaction-tool-result-pruner` keeps a head/tail when compaction
 * triggers — its own Dev Note defers "semantic middle selection" because it
 * "would need a model or structured heuristics".
 *
 * This module is that semantic selection, and nothing else: it keeps the
 * interesting middle and drops repetition, only for output-heavy tools, only
 * above a size threshold, only a bounded number of times per turn, and only
 * when the cheap pre-check says the text is actually repetitive. Any failure
 * returns the original content untouched.
 * @module dsh-jev/result-shaper
 */

import { noul, resolveClientFrom, type TypeSafeClient } from './typesafe-client.js'
import { defaultMetrics } from './metrics.js'
import { defaultDecisionLog } from './decisions.js'
import type { CordisContext, PostToolDecision, ResultShaperConfig, ToolExecution } from './types.js'

export const name = 'typesafe-result-shaper'

/** One model-facing content block, as the tools service carries it. */
export interface ContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

/**
 * Text of a tool result, whether it arrives as a plain string or as the block
 * array the real tools service uses. Returning undefined means there is nothing
 * textual to shape.
 */
export function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content as ContentBlock[]) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/**
 * Rebuild the content with the shaped text. In the block form the text blocks
 * collapse into one, and every non-text block keeps its relative position —
 * the same property DSH's own pruner preserves.
 */
export function replaceText(content: unknown, text: string): unknown {
  if (typeof content === 'string') return text
  if (!Array.isArray(content)) return text
  const rebuilt: ContentBlock[] = []
  let inserted = false
  for (const block of content as ContentBlock[]) {
    if (block && block.type === 'text') {
      if (!inserted) {
        rebuilt.push({ ...block, text })
        inserted = true
      }
      continue
    }
    rebuilt.push(block)
  }
  if (!inserted) rebuilt.push({ type: 'text', text })
  return rebuilt
}

export const DEFAULT_SHAPE_TOOLS = [
  'bash',
  'pwsh',
  'terminal',
  'run_command',
  'execute_command',
]

export const DROP_MARKER = '[... %d lines dropped by TypeSafe result shaper ...]'

/** Documented defaults; `tests/docs-consistency.spec.ts` keeps README in step. */
export const DEFAULT_THRESHOLD_CHARS = 8000
export const DEFAULT_MAX_PER_TURN = 2
export const DEFAULT_LINES_PER_SEGMENT = 40
export const DEFAULT_MAX_SEGMENTS = 24
export const DEFAULT_KEEP_THRESHOLD = 0.5
/** Characters of each block sent for judgement; the model judges, it does not read. */
export const DEFAULT_BLOCK_PREVIEW_CHARS = 600
/** The shaping request is the plugin's largest, so it gets its own budget. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 4000
/**
 * Minimum separation between the highest and lowest keep-probability for the
 * shaper to act. Below it the model is not discriminating and dropping blocks
 * would be arbitrary.
 */
export const DEFAULT_SPREAD_THRESHOLD = 0.15

/** Group lines into contiguous segments so one question covers a coherent block. */
export function segmentText(text: string, linesPerSegment: number, maxSegments: number): string[] {
  const lines = text.split('\n')
  const raw: string[] = []
  for (let index = 0; index < lines.length; index += linesPerSegment) {
    raw.push(lines.slice(index, index + linesPerSegment).join('\n'))
  }
  if (raw.length <= maxSegments) return raw

  // Coalesce evenly so the cap holds without discarding the tail.
  const perSegment = Math.ceil(raw.length / maxSegments)
  const merged: string[] = []
  for (let index = 0; index < raw.length; index += perSegment) {
    merged.push(raw.slice(index, index + perSegment).join('\n'))
  }
  return merged
}

/**
 * Cheap pre-check: is this output dominated by low-information bulk?
 *
 * Byte-identical repetition alone is too narrow: build logs, dependency trees
 * and file listings vary on every line (a counter, a path, a version) and are
 * exactly the output that fills a context window. Volume and structural
 * repetition both count, and everything still passes the model's per-block
 * judgement before anything is dropped.
 */
export function looksRepetitive(text: string): boolean {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  // A few very long lines (a minified bundle, a base64 blob) qualify on their own.
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0)
  if (longest > 4000) return true

  // Bulk by volume: a long listing is worth one bounded decision even when every
  // line differs.
  if (lines.length >= 120) return true

  if (lines.length < 40) return false
  if (uniqueRatio(lines) >= 0.25) return true
  // Structurally identical lines that only differ in numbers, hashes or paths.
  const shapes = lines.map((line) => line.replace(/[0-9a-f]{6,}|\d+/gi, '#'))
  return uniqueRatio(shapes) >= 0.5
}

/** Share of lines that repeat an earlier line verbatim. */
function uniqueRatio(lines: string[]): number {
  return 1 - new Set(lines).size / lines.length
}

export class ResultShaperService {
  private shapedThisTurn = 0
  /**
   * Set when the model failed to separate the blocks. Every measured question
   * shape behaves this way on bulk output (docs/calibration.md §9), so once it
   * happens the rest of the turn skips further shaping attempts instead of
   * spending another bounded request on the same non-answer.
   */
  private declinedThisTurn = false

  constructor(
    private readonly getClient: () => TypeSafeClient,
    private readonly config: ResultShaperConfig = {}
  ) {}

  /** Reset the per-turn budget; called on each new user instruction. */
  resetTurnBudget(): void {
    this.shapedThisTurn = 0
    this.declinedThisTurn = false
  }

  shouldConsider(exec: ToolExecution, content: string): boolean {
    if (this.declinedThisTurn) return false
    const tools = this.config.shapeTools ?? DEFAULT_SHAPE_TOOLS
    if (!tools.includes(exec?.name)) return false
    if (content.length < (this.config.thresholdChars ?? DEFAULT_THRESHOLD_CHARS)) return false
    if (this.shapedThisTurn >= (this.config.maxPerTurn ?? DEFAULT_MAX_PER_TURN)) return false
    return looksRepetitive(content)
  }

  /**
   * Keep the segments Jev judges still informative, drop the rest.
   * @returns the shaped text, or undefined when shaping is not justified.
   */
  async shape(content: string, toolName: string): Promise<{ text: string; droppedSegments: number; keptSegments: number; latencyMs: number } | undefined> {
    const segments = segmentText(content, this.config.linesPerSegment ?? DEFAULT_LINES_PER_SEGMENT, this.config.maxSegments ?? DEFAULT_MAX_SEGMENTS)
    if (segments.length < 3) return undefined

    const questions: Record<string, unknown> = {}
    segments.forEach((_segment, index) => {
      questions['keep_' + index] = noul(
        'Does this block of command output still carry information a developer needs ' +
          '(errors, results, counts, decisions, paths), rather than repetitive noise that can be dropped?'
      )
    })

    const started = Date.now()
    const client = this.getClient()
    const results = await client.systemOne(
      {
        state: {
          tool: toolName,
          note: 'Output is split into ordered blocks; decide per block whether to keep it.',
          // Enough of each block to judge whether it informs; sending it whole
          // made a 24-block request tens of kilobytes.
          blocks: segments.map((segment, index) => ({ index, text: segment.slice(0, this.config.blockPreviewChars ?? DEFAULT_BLOCK_PREVIEW_CHARS) })),
        },
        questions: questions as any,
      },
      { timeoutMs: this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS }
    )
    const latencyMs = Date.now() - started

    const keep: boolean[] = segments.map((_segment, index) => {
      const answer = results['keep_' + index] as any
      if (!answer || answer.unknown) return true // unknown keeps content
      const probability = typeof answer.noul === 'number' ? answer.noul : answer.probability
      return typeof probability !== 'number' ? true : probability >= (this.config.keepThreshold ?? DEFAULT_KEEP_THRESHOLD)
    })

    // Measured 2026-09-18 (docs/calibration.md §9): on build-log output the model
    // returns a flat distribution — every block near-identical, the one block
    // carrying the actual error included. Acting on that would drop blocks at
    // random, error block included, so a distribution that does not separate is
    // treated as "cannot decide" and the original content survives.
    const scored = segments
      .map((_segment, index) => {
        const answer = results['keep_' + index] as any
        if (!answer || answer.unknown) return undefined
        const probability = typeof answer.noul === 'number' ? answer.noul : answer.probability
        return typeof probability === 'number' ? probability : undefined
      })
      .filter((value): value is number => value !== undefined)
    if (scored.length < segments.length) return undefined
    const spread = Math.max(...scored) - Math.min(...scored)
    if (spread < (this.config.spreadThreshold ?? DEFAULT_SPREAD_THRESHOLD)) {
      this.declinedThisTurn = true
      return undefined
    }

    const keptSegments = keep.filter(Boolean).length
    const droppedSegments = keep.length - keptSegments
    // Shaping must be a clear win: keep at least the informative part and drop real volume.
    if (droppedSegments === 0 || keptSegments === 0) return undefined

    let droppedLines = 0
    const rebuilt: string[] = []
    let runStart = -1
    const flushRun = (endExclusive: number) => {
      if (runStart < 0) return
      const lines = segments.slice(runStart, endExclusive).join('\n').split('\n').length
      droppedLines += lines
      rebuilt.push(DROP_MARKER.replace('%d', String(lines)))
      runStart = -1
    }

    keep.forEach((keepIt, index) => {
      if (keepIt) {
        flushRun(index)
        rebuilt.push(segments[index]!)
      } else if (runStart < 0) {
        runStart = index
      }
    })
    flushRun(keep.length)

    const text = rebuilt.join('\n')
    if (text.length >= content.length) return undefined

    this.shapedThisTurn += 1
    return { text, droppedSegments, keptSegments, latencyMs }
  }
}

export function apply(ctx: CordisContext, config: ResultShaperConfig = {}) {
  const shaper = new ResultShaperService(() => resolveClientFrom(ctx), config)

  // Waterfall listener: the budget reset must not swallow the step decision.
  const unsubscribePreStep = ctx.on('agent/pre-step', (...hookArgs: any[]) => {
    const next = hookArgs[hookArgs.length - 1]
    shaper.resetTurnBudget()
    return typeof next === 'function' ? next() : undefined
  })

  const unsubscribe = ctx.on('tools/post-execute', async (...hookArgs: any[]): Promise<PostToolDecision> => {
    let exec: ToolExecution
    let result: any
    let next: () => Promise<PostToolDecision>

    if (hookArgs.length >= 3 && typeof hookArgs[2] === 'function') {
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

    const baseDecision = await next()

    try {
      if (!result || result.isError) return baseDecision
      // The real service carries content as a block array; a string-only check
      // made this module inert in the pipeline while its unit tests passed.
      const originalText = extractText(result.content)
      if (originalText === undefined) return baseDecision
      if (!shaper.shouldConsider(exec, originalText)) return baseDecision
      // A downstream listener already replaced the value; content replacement
      // alongside it is rejected by the tools service.
      if (baseDecision && Object.hasOwn(baseDecision, 'value')) return baseDecision
      // Another listener already rewrote the content; do not clobber its decision.
      if (baseDecision && Object.hasOwn(baseDecision, 'content')) return baseDecision
      if (baseDecision && baseDecision.kind === 'block') return baseDecision

      const shaped = await shaper.shape(originalText, exec.name)
      if (!shaped) return baseDecision

      defaultMetrics.recordShape(originalText.length - shaped.text.length)
      defaultDecisionLog.append({
        module: 'result-shaper',
        action: 'shaped',
        latencyMs: shaped.latencyMs,
        detail: {
          tool: exec.name,
          keptSegments: shaped.keptSegments,
          droppedSegments: shaped.droppedSegments,
          charsRemoved: originalText.length - shaped.text.length,
        },
      })

      return {
        ...(baseDecision as any),
        kind: 'accept',
        action: 'accept',
        content: replaceText(result.content, shaped.text),
      }
    } catch (err) {
      // Never change what the tool returned because a decision failed.
      console.warn('[TypeSafe ResultShaper] Shaping failed, returning original content:', err)
      return baseDecision
    }
  })

  return () => {
    unsubscribePreStep()
    unsubscribe()
  }
}
