// Settle the token accounting: is `cacheReadTokens` per-request or cumulative, and what is
// the real prompt total per session?
//   total prompt tokens = sum(inputTokens) + sum(cacheReadTokens)   when both are per-request
//                       = sum(inputTokens) + sum(cumulative deltas) when cache is a counter
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decode(file) {
  const buffer = readFileSync(file)
  const offsets = []
  let index = buffer.indexOf(MAGIC)
  while (index !== -1) {
    offsets.push(index)
    index = buffer.indexOf(MAGIC, index + 4)
  }
  let text = ''
  for (let i = 0; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
    try { text += zstdDecompressSync(buffer.subarray(offsets[i], end)).toString('utf8') } catch { /* tail */ }
  }
  return text
}

function findSession(target) {
  if (statSync(target).isFile()) return target
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.zstd')) found.push(path)
    }
  }
  walk(target)
  return found.sort((a, b) => statSync(b).size - statSync(a).size)[0]
}

const findKey = (value, keys, depth = 0) => {
  if (!value || typeof value !== 'object' || depth > 4) return undefined
  for (const key of keys) if (typeof value[key] === 'number') return value[key]
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findKey(child, keys, depth + 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

const session = findSession(process.argv[2])
console.log('session:', session)
const series = { inputTokens: [], outputTokens: [], cacheReadTokens: [], reasoningTokens: [] }
for (const line of decode(session).split('\n')) {
  if (!line) continue
  let record
  try { record = JSON.parse(line) } catch { continue }
  if (record.type !== 'assistant/message') continue
  for (const key of Object.keys(series)) {
    const value = findKey(record, [key])
    if (value !== undefined) series[key].push(value)
  }
}

const sum = (values) => values.reduce((a, b) => a + b, 0)
for (const [key, values] of Object.entries(series)) {
  if (values.length === 0) continue
  let decreases = 0
  for (let i = 1; i < values.length; i += 1) if (values[i] < values[i - 1]) decreases += 1
  console.log(
    `${key}: n=${values.length} sum=${sum(values)} min=${Math.min(...values)} ` +
    `max=${Math.max(...values)} decreases=${decreases} => ${decreases === 0 ? 'CUMULATIVE' : 'per-request'}`
  )
}

// Cumulative deltas, when the field resets downward (compaction) count the rise as a new run.
const cumulativeTotal = (values) => {
  let total = 0
  let previous = 0
  for (const value of values) {
    if (value >= previous) total += value - previous
    else total += value
    previous = value
  }
  return total
}

const input = sum(series.inputTokens)
const cacheSum = sum(series.cacheReadTokens)
const cacheDelta = cumulativeTotal(series.cacheReadTokens)
console.log('\nderived:')
console.log(`  prompt total if cache is per-request : ${input + cacheSum}`)
console.log(`  prompt total if cache is cumulative  : ${input + cacheDelta}`)
console.log(`  output+reasoning: ${sum(series.outputTokens) + sum(series.reasoningTokens)}`)
process.exit(0)
