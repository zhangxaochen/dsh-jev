/**
 * Compaction-budget probe: what does the verbatim tail actually cost the provider?
 *
 * DSH's `dsh-compaction-basic` keeps the newest `retainRatio × contextWindow` tokens
 * verbatim after a compaction (`retainRatio: 0.16` by default) and prices that tail with
 * `@deepseek-ai/dsh-token-meter`, whose estimator is a flat **4 characters per token**.
 * The host's own Dev Note names the consequence: that density "underprices CJK text and
 * JSON Schema documents". A Chinese-heavy deployment therefore keeps ~1.5x the tokens it
 * asked for, and the number a session reports after a compaction (`assistant/message.usage`)
 * disagrees with the budget in the config - which is what this probe measures instead of
 * asserting.
 *
 * It reads **finished session logs** (no network, no API key, no DSH runtime) and, for
 * every completed compaction, computes:
 *
 *   retainedTailMeterTokens  the tail the engine selected, priced with the meter's own
 *                            heuristic (re-implemented here, see `estimateMessage`)
 *   measuredTailTokens       what the provider counted for the next request's prompt,
 *                            minus the tool schemas, system prompt and checkpoint summary
 *   providerOverMeterFactor  measuredTailTokens / retainedTailMeterTokens
 *
 * and then prints the `retainTokens` that would hit a target **real** post-compaction
 * budget on this deployment: `retainTokens = (target - fixedFloor) / factor`.
 *
 * Run: node --experimental-strip-types tests/probe-compaction-tokens.ts [session files...]
 * Writes docs/calibration/probe-<date>-compaction-tokens.json
 *
 * Without arguments it discovers the five largest session logs under `$DSH_HOME/sessions`;
 * a machine with no such logs prints SKIP and writes nothing, so the script is safe to run
 * anywhere.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Zstandard frame magic; a session log is a concatenation of independently decodable frames. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Text density the host meter uses, and the per-block structural overhead it adds. */
const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4

/** Target **real** post-compaction prompt budgets to translate into `retainTokens`. */
const TARGET_AFTER_TOKENS = [20000, 30000, 45000]

/** How many session logs to auto-discover, largest first. */
const DISCOVER_LIMIT = 5

interface SessionEvent {
  type: string
  seq: number
  data?: any
}

interface CompactionSample {
  session: string
  compactionId: string | undefined
  summarySeq: number
  shadowedRange: { start: number; end: number }
  shadowedMeterTokens: number
  retainedTailNodes: number
  retainedTailMeterTokens: number
  toolsMeterTokens: number
  systemMeterTokens: number
  summaryMeterTokens: number
  fixedFloorMeterTokens: number
  observedBeforeTokens: number | undefined
  observedAfterTokens: number
  measuredTailTokens: number
  providerOverMeterFactor: number
}

interface SessionReport {
  /** Session directory name, so the artifact names its source without an absolute path. */
  session: string
  events: number
  bytes: number
  compactions: CompactionSample[]
  skipped: string[]
}

/** Read the meter's estimator behaviour from the host: text/JSON density, recursive tool results. */
function estimateContentTokens(blocks: any): number {
  let tokens = 0
  for (const block of (blocks ?? []) as any[]) {
    switch (block?.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil((block.text?.length ?? 0) / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens +=
          Math.ceil((block.name?.length ?? 0) / CHARS_PER_TOKEN) +
          Math.ceil((block.arguments?.length ?? 0) / CHARS_PER_TOKEN) +
          BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateContentTokens(block.content) + BLOCK_OVERHEAD
        break
      default:
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block ?? null).length / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

/** Price one model-visible message exactly as the host meter does, role framing included. */
function estimateMessageTokens(message: any): number {
  if (message?.role === 'system') {
    let characters = 0
    for (const block of (message.content ?? []) as any[]) {
      characters += block?.type === 'text' ? (block.text?.length ?? 0) : JSON.stringify(block ?? null).length
    }
    return Math.ceil(characters / CHARS_PER_TOKEN) + 4
  }
  return estimateContentTokens(message?.content) + 4
}

/** Prompt tokens the provider reported for one assistant message. */
function promptTokens(usage: any): number | undefined {
  if (usage === undefined || usage === null) return undefined
  const total = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  return Number.isFinite(total) && total > 0 ? total : undefined
}

/** Decode a concatenated-frame Zstandard session log into its JSONL events. */
function decodeSession(file: string): SessionEvent[] {
  const bytes = readFileSync(file)
  const starts: number[] = []
  for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
    if (bytes.compare(ZSTD_MAGIC, 0, 4, offset, offset + 4) === 0) {
      starts.push(offset)
      offset += 3
    }
  }
  let text = ''
  starts.forEach((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : bytes.length
    text += zstdDecompressSync(bytes.subarray(start, end)).toString('utf8')
  })
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as SessionEvent
      } catch {
        return null
      }
    })
    .filter((event): event is SessionEvent => event !== null && typeof event.seq === 'number')
}

/** One completed compaction, priced three ways: engine budget, prompt truth, and fixed overhead. */
function sampleCompaction(
  session: string,
  events: SessionEvent[],
  startSeq: number,
  summary: SessionEvent,
  headers: SessionEvent[],
  messages: SessionEvent[],
  system: SessionEvent | undefined
): CompactionSample | undefined {
  const shadowedRange = summary.data?.shadowedRange
  if (shadowedRange === undefined) return undefined

  const after = messages.find((event) => event.seq > summary.seq && promptTokens(event.data?.usage) !== undefined)
  if (after === undefined) return undefined
  const observedAfterTokens = promptTokens(after.data.usage)!
  const before = [...messages].reverse().find((event) => event.seq < startSeq)
  const observedBeforeTokens = before === undefined ? undefined : promptTokens(before.data?.usage)

  // The retained tail is exactly the surface between the range end and the compaction
  // marker: the engine replaces [start, end] and keeps everything after it.
  const tail = events.filter(
    (event) =>
      event.seq > shadowedRange.end && event.seq < startSeq && event.data?.message !== undefined
  )
  const retainedTailMeterTokens = tail.reduce(
    (total, event) => total + estimateMessageTokens(event.data.message),
    0
  )
  if (retainedTailMeterTokens <= 0) return undefined

  // The header of the request that follows the compaction is the one the model saw.
  const header = [...headers].reverse().find((event) => event.seq < after.seq)
  const toolsMeterTokens =
    header === undefined ? 0 : Math.ceil(JSON.stringify(header.data?.header?.tools ?? []).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
  const systemMeterTokens = system === undefined ? 0 : estimateMessageTokens(system.data.message)
  const summaryMeterTokens = Math.ceil(
    ((summary.data.summary ?? []) as any[]).reduce((total, block) => total + (block?.text?.length ?? 0), 0) /
      CHARS_PER_TOKEN
  )
  const fixedFloorMeterTokens = toolsMeterTokens + systemMeterTokens + summaryMeterTokens

  // Everything the provider counted beyond the fixed floor is attributed to the tail; the
  // floor's own estimation error is absorbed here rather than modelled (see caveats).
  const measuredTailTokens = observedAfterTokens - fixedFloorMeterTokens
  if (measuredTailTokens <= 0) return undefined

  return {
    session,
    compactionId: summary.data?.compactionId,
    summarySeq: summary.seq,
    shadowedRange: { start: shadowedRange.start, end: shadowedRange.end },
    shadowedMeterTokens: summary.data?.shadowedTokenCount ?? 0,
    retainedTailNodes: tail.length,
    retainedTailMeterTokens,
    toolsMeterTokens,
    systemMeterTokens,
    summaryMeterTokens,
    fixedFloorMeterTokens,
    observedBeforeTokens,
    observedAfterTokens,
    measuredTailTokens,
    providerOverMeterFactor: Number((measuredTailTokens / retainedTailMeterTokens).toFixed(3)),
  }
}

function reportSession(file: string): SessionReport {
  // The session id is the directory holding the log; an absolute path in the artifact
  // would publish one operator's machine layout for no diagnostic gain.
  const session = basename(dirname(file))
  const events = decodeSession(file)
  const headers = events.filter((event) => event.type === 'request/header')
  const messages = events.filter((event) => event.type === 'assistant/message')
  const system = events.filter((event) => event.type === 'system/message').at(-1)
  const starts = events.filter((event) => event.type === 'compaction/start')
  const summaries = events.filter((event) => event.type === 'compaction/summary')

  const compactions: CompactionSample[] = []
  const skipped: string[] = []
  summaries.forEach((summary, index) => {
    const start = starts[index]
    if (start === undefined) {
      skipped.push('summary seq ' + summary.seq + ': no compaction/start marker')
      return
    }
    const sample = sampleCompaction(session, events, start.seq, summary, headers, messages, system)
    if (sample === undefined) skipped.push('summary seq ' + summary.seq + ': no usable post-compaction prompt or empty tail')
    else compactions.push(sample)
  })

  return { session, events: events.length, bytes: statSync(file).size, compactions, skipped }
}

/** Candidate session logs: the largest `*.jsonl.zstd` under `$DSH_HOME/sessions`. */
function discoverSessions(): string[] {
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
  if (!existsSync(root)) return []
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) found.push(path)
    }
  }
  walk(root)
  return found
    .map((file) => ({ file, size: statSync(file).size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, DISCOVER_LIMIT)
    .map((entry) => entry.file)
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function main(): void {
  if (typeof zstdDecompressSync !== 'function') {
    console.log('SKIP: this Node build has no zstdDecompressSync (needs >= 22.15)')
    return
  }

  const args = process.argv.slice(2).filter((argument) => !argument.startsWith('-'))
  const files = args.length > 0 ? args : discoverSessions()
  if (files.length === 0) {
    console.log('SKIP: no session logs found; pass one or more *.jsonl.zstd paths explicitly')
    return
  }

  const sessions: SessionReport[] = []
  for (const file of files) {
    try {
      sessions.push(reportSession(file))
    } catch (error) {
      console.log('SKIP ' + file + ': ' + String((error as Error)?.message ?? error))
    }
  }

  const samples = sessions.flatMap((session) => session.compactions)
  if (samples.length === 0) {
    console.log('SKIP: ' + files.length + ' session log(s) decoded, none holds a completed compaction')
    for (const session of sessions) for (const note of session.skipped) console.log('  ' + session.session + ': ' + note)
    return
  }

  console.log('session                          seq   tail(meter)  tail(provider)  factor  floor   after   before')
  for (const sample of samples) {
    console.log(
      [
        sample.session.slice(0, 30).padEnd(32),
        String(sample.summarySeq).padStart(5),
        String(sample.retainedTailMeterTokens).padStart(13),
        String(sample.measuredTailTokens).padStart(16),
        String(sample.providerOverMeterFactor).padStart(7),
        String(sample.fixedFloorMeterTokens).padStart(6),
        String(sample.observedAfterTokens).padStart(7),
        String(sample.observedBeforeTokens ?? '-').padStart(8),
      ].join(' ')
    )
  }

  const factors = samples.map((sample) => sample.providerOverMeterFactor)
  const floors = samples.map((sample) => sample.fixedFloorMeterTokens)
  const factor = median(factors) ?? 1
  const floor = Math.round(median(floors) ?? 0)

  const recommendations = TARGET_AFTER_TOKENS.map((target) => {
    const retainTokens = Math.max(0, Math.round((target - floor) / factor))
    return {
      targetAfterTokens: target,
      retainTokens,
      predictedAfterTokens: Math.round(retainTokens * factor + floor),
    }
  })

  console.log(
    '\nmeasured factor (median real/meter): ' + factor.toFixed(3) +
      '  range ' + Math.min(...factors).toFixed(3) + '-' + Math.max(...factors).toFixed(3) +
      '  over ' + samples.length + ' compaction(s)'
  )
  console.log('fixed floor (tools + system + summary, meter): ~' + floor + ' tokens')
  console.log('\ntarget after  ->  retainTokens  ->  predicted after')
  for (const row of recommendations) {
    console.log(
      String(row.targetAfterTokens).padStart(12) + '  ->  ' + String(row.retainTokens).padStart(12) +
        '  ->  ' + String(row.predictedAfterTokens).padStart(16)
    )
  }

  const report = {
    ranAt: new Date().toISOString(),
    meter: {
      charsPerToken: CHARS_PER_TOKEN,
      blockOverhead: BLOCK_OVERHEAD,
      source: 're-implemented from @deepseek-ai/dsh-token-meter/lib/index.js (estimateMessage/estimateContent)',
      note: 'the host Dev Note states this density underprices CJK text and JSON Schema documents',
    },
    targetAfterTokens: TARGET_AFTER_TOKENS,
    aggregate: {
      samples: samples.length,
      sessions: sessions.length,
      factorMedian: factor,
      factorMin: Math.min(...factors),
      factorMax: Math.max(...factors),
      fixedFloorMeterTokens: floor,
      recommendations,
    },
    caveats: [
      'the system prompt, tool schemas and checkpoint summary are priced with the same biased meter, so their error is absorbed into the measured factor rather than modelled',
      'the factor is a property of this deployment\'s content mix (CJK and JSON share), not a constant: rerun after the mix or the host meter changes',
      'sessions that end mid-compaction, and compactions with no following assistant/message usage, are skipped and listed per session',
      'the estimator is re-implemented here; a host upgrade that changes it invalidates the comparison until this file is updated',
    ],
    sessions,
  }

  const outDir = join(process.cwd(), 'docs', 'calibration')
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, 'probe-' + new Date().toISOString().slice(0, 10) + '-compaction-tokens.json')
  writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8')
  console.log('\nwrote ' + outFile)
}

main()
