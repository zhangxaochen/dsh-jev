// Count the real efficiency checkpoints of a dsh run from its archived session transcript:
// wall-clock is pier's, but tokens, steps, turns and tool calls live only here.
//
// Usage: node session-metrics.mjs <session.v3.jsonl.zstd | job-dir> [--inspect]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function framesToText(buffer) {
  const offsets = []
  let index = buffer.indexOf(MAGIC)
  while (index !== -1) {
    offsets.push(index)
    index = buffer.indexOf(MAGIC, index + 4)
  }
  let text = ''
  for (let i = 0; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(offsets[i], end)).toString('utf8')
    } catch { /* a torn frame at the tail */ }
  }
  return text
}

function findSession(target) {
  const stats = statSync(target)
  if (stats.isFile()) return target
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.zstd')) found.push(path)
    }
  }
  walk(target)
  if (found.length === 0) throw new Error(`no session transcript under ${target}`)
  return found.sort((a, b) => statSync(b).size - statSync(a).size)[0]
}

const target = process.argv[2]
const inspect = process.argv.includes('--inspect')
const session = findSession(target)
console.log('session:', session, `${(statSync(session).size / 1048576).toFixed(1)}MB`)

const records = framesToText(readFileSync(session))
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try { return JSON.parse(line) } catch { return null }
  })
  .filter(Boolean)

const counts = new Map()
for (const record of records) counts.set(record.type, (counts.get(record.type ?? '?') ?? 0) + 1)

if (inspect) {
  // Where does usage actually live? Print the path of every usage-shaped number, once.
  const seen = new Set()
  const walk = (value, path) => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (/tokens?|usage|cached|cost/i.test(key) && typeof child === 'number') {
        const where = `${path}${key}`
        if (!seen.has(where)) {
          seen.add(where)
          console.log(`  ${where} = ${child}`)
        }
      } else if (child && typeof child === 'object') walk(child, path)
    }
  }
  for (let i = 0; i < records.length; i += 1) {
    const type = records[i].type ?? '?'
    if (!/assistant|request|step\/end|turn\/end/.test(type)) continue
    console.log(`\n[${type}] record ${i}`)
    walk(records[i], '')
  }
  process.exit(0)
}

// The canonical per-request usage sits on `assistant/message` records, nested somewhere
// inside them; summing usage-shaped numbers across all record types double-counts the
// cumulative counters that other records embed.
const usage = { input: 0, cached: 0, output: 0, reasoning: 0, requests: 0, contextPeak: 0 }
const findKey = (value, keys, depth = 0) => {
  if (!value || typeof value !== 'object' || depth > 4) return 0
  for (const key of keys) {
    if (typeof value[key] === 'number') return value[key]
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findKey(child, keys, depth + 1)
      if (found) return found
    }
  }
  return 0
}
for (const record of records) {
  if (record.type !== 'assistant/message') continue
  const found = {
    input: findKey(record, ['inputTokens', 'promptTokens']),
    output: findKey(record, ['outputTokens', 'completionTokens']),
    cached: findKey(record, ['cacheReadTokens', 'cachedTokens']),
    reasoning: findKey(record, ['reasoningTokens']),
  }
  if (found.input || found.output || found.cached || found.reasoning) {
    usage.requests += 1
    usage.input += found.input
    usage.cached += found.cached
    usage.output += found.output
    usage.reasoning += found.reasoning
    // Measured on real sessions: cacheReadTokens is per-request (it decreases once, at the
    // compaction reset), so it sums. Reporting only its peak understated the prompt total
    // by ~60x; the honest headline is input + cached.
    usage.contextPeak = Math.max(usage.contextPeak, found.input + found.cached)
  }
}

const value = (type) => counts.get(type) ?? 0

// Pair tool calls with their results by callId: a call that never produced a result means
// the tool did not run - the most direct signal that pruning or a guard removed it.
const called = new Set()
const answered = new Set()
for (const record of records) {
  const source = record?.data?.message?.source
  const callId = source?.callId
  if (typeof callId !== 'string') continue
  if (record.type === 'tool/call') called.add(callId)
  if (record.type === 'tool/result') answered.add(callId)
}
let unanswered = 0
for (const callId of called) if (!answered.has(callId)) unanswered += 1
console.log('\nrecords:', records.length)
console.log('| checkpoint | value |')
console.log('| --- | --- |')
console.log(`| steps (step/start) | ${value('step/start')} |`)
console.log(`| turns (turn/start) | ${value('turn/start')} |`)
console.log(`| assistant messages | ${value('assistant/message')} |`)
console.log(`| tool calls | ${value('tool/call')} |`)
console.log(`| tool results | ${value('tool/result')} |`)
console.log(`| approvals asked | ${value('approval/asked')} |`)
console.log(`| compactions | ${value('compaction/start')} |`)
console.log(`| llm retries | ${value('llm/retry')} |`)
console.log(`| requests with usage | ${usage.requests} |`)
console.log(`| input tokens, uncached part (sum) | ${usage.input} |`)
console.log(`| input tokens, cached part (sum) | ${usage.cached} |`)
console.log(`| prompt tokens, total (uncached + cached) | ${usage.input + usage.cached} |`)
console.log(`| output tokens | ${usage.output} |`)
console.log(`| reasoning tokens | ${usage.reasoning} |`)
console.log(`| largest single-request prompt (input + cached) | ${usage.contextPeak} |`)
process.exit(0)
