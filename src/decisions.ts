/**
 * Append-only decision log for calibration.
 *
 * Every semantic decision is recorded with the facts needed to re-derive its
 * threshold later: the question, the answer, its confidence, the action taken,
 * the measured latency and the billed input size. This is the dataset the
 * calibration table in docs/calibration.md is supposed to be built from.
 * @module dsh-jev/decisions
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface DecisionRecord {
  /** ISO timestamp. */
  ts: string
  /** Owning module, e.g. `loop-guard` or `safety-guard`. */
  module: string
  /** Action taken: pass, warn, interrupt, ask, deny, hard-deny. */
  action: string
  latencyMs?: number
  /** Answer confidence in [0, 1] when the primitive reports one. */
  confidence?: number
  /** Deciding probability, e.g. dead-loop bucket mass or hazard probability. */
  probability?: number
  /** Billed input bytes for this decision (0 for a cache hit or deterministic veto). */
  inputBytes?: number
  estimatedCostUsd?: number
  /** Free-form context: tool name, rule id, model score. */
  detail?: Record<string, unknown>
}

/** A decision as supplied by a guard: `ts` is filled in on append. */
export type DecisionInput = Omit<DecisionRecord, 'ts'> & { ts?: string }

export const DEFAULT_DECISION_LOG = join(homedir(), '.dsh', 'jev-decisions.jsonl')

export class DecisionLog {
  constructor(private readonly path: string = DEFAULT_DECISION_LOG) {}

  /** Append one decision. Never throws: logging must not break an agent turn. */
  append(record: DecisionInput): void {
    try {
      const full: DecisionRecord = { ...record, ts: record.ts ?? new Date().toISOString() }
      mkdirSync(dirname(this.path), { recursive: true })
      appendFileSync(this.path, JSON.stringify(full) + '\n', 'utf8')
    } catch {
      /* read-only or unwritable home: decisions simply stay unlogged */
    }
  }

  /** Read every recorded decision, skipping unparsable lines. */
  read(): DecisionRecord[] {
    if (!existsSync(this.path)) return []
    const out: DecisionRecord[] = []
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      try {
        out.push(JSON.parse(line) as DecisionRecord)
      } catch {
        /* a truncated tail line is expected after a crash */
      }
    }
    return out
  }

  /**
   * Per-action counts plus the confidence distribution per module, which is what
   * a threshold review actually needs.
   */
  summarize(): {
    total: number
    byModule: Record<string, Record<string, number>>
    confidence: Record<string, { count: number; min: number; max: number; mean: number }>
  } {
    const byModule: Record<string, Record<string, number>> = {}
    const buckets: Record<string, number[]> = {}
    const records = this.read()

    for (const record of records) {
      const module = record.module || 'unknown'
      byModule[module] = byModule[module] ?? {}
      byModule[module][record.action] = (byModule[module][record.action] ?? 0) + 1
      if (typeof record.confidence === 'number') {
        const key = module + ':' + record.action
        buckets[key] = buckets[key] ?? []
        buckets[key].push(record.confidence)
      }
    }

    const confidence: Record<string, { count: number; min: number; max: number; mean: number }> = {}
    for (const [key, values] of Object.entries(buckets)) {
      const sum = values.reduce((acc, value) => acc + value, 0)
      confidence[key] = {
        count: values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        mean: Number((sum / values.length).toFixed(3)),
      }
    }

    return { total: records.length, byModule, confidence }
  }
}

/** Shared instance used by the guard plugins. */
export const defaultDecisionLog = new DecisionLog()
