// Paired cost comparison: for tasks where both arms scored the same, did the plugin arm spend
// less to get there?
//
// The score channel is uninformative so far - 11 of 13 pairs tie exactly, and run-to-run
// variance (+-56pp on one task) swamps the +-2pp differences. Cost is the other half of the
// question: on a task both arms solve, fewer tokens or fewer steps for the same reward is a
// real benefit even when the score cannot move.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const PILOT = 'D:/code/dsh-jev/tmp/pier-pilot'
const JOBS = 'D:/code/deep-swe/jobs'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ids = readFileSync(join(PILOT, 'top20-ids.txt'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)

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
    try {
      text += zstdDecompressSync(buffer.subarray(offsets[i], end)).toString('utf8')
    } catch {}
  }
  return text
}

function metrics(base) {
  const session = join(base, 'artifacts', 'agent', 'sessions', 'session.v3.jsonl.zstd')
  if (!existsSync(session)) return undefined
  const records = decode(session)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  // Canonical per-request usage sits on assistant/message records; summing usage-shaped
  // numbers across every record type double-counts cumulative counters embedded elsewhere.
  const findKey = (value, keys, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 4) return 0
    for (const key of keys) if (typeof value[key] === 'number') return value[key]
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') {
        const found = findKey(child, keys, depth + 1)
        if (found) return found
      }
    }
    return 0
  }
  let uncached = 0
  let cached = 0
  let output = 0
  let reasoning = 0
  let steps = 0
  let calls = 0
  for (const record of records) {
    if (record.type === 'step/start') steps += 1
    if (record.type === 'tool/call') calls += 1
    if (record.type !== 'assistant/message') continue
    uncached += findKey(record, ['inputTokens', 'promptTokens'])
    cached += findKey(record, ['cacheReadTokens', 'cachedTokens'])
    output += findKey(record, ['outputTokens', 'completionTokens'])
    reasoning += findKey(record, ['reasoningTokens'])
  }
  let wall = 0
  const result = join(base, 'result.json')
  if (existsSync(result)) {
    try {
      const payload = JSON.parse(readFileSync(result, 'utf8'))
      wall = (new Date(payload.finished_at) - new Date(payload.started_at)) / 1000
    } catch {}
  }
  return { uncached, cached, prompt: uncached + cached, output, reasoning, steps, calls, wall, mtime: statSync(base).mtimeMs }
}

const pairs = new Map()
for (const job of existsSync(JOBS) ? readdirSync(JOBS) : []) {
  if (!job.startsWith('2026-09-20')) continue
  for (const inner of readdirSync(join(JOBS, job))) {
    const base = join(JOBS, job, inner)
    const prefix = inner.split('__')[0]
    const task = ids.find((id) => id.startsWith(prefix) || prefix.startsWith(id.slice(0, 28)))
    if (!task) continue
    const setup = join(base, 'artifacts', 'agent', 'setup.txt')
    const rewardFile = join(base, 'verifier', 'reward.json')
    if (!existsSync(setup) || !existsSync(rewardFile)) continue
    let reward
    try {
      reward = JSON.parse(readFileSync(rewardFile, 'utf8')).reward
    } catch {
      continue
    }
    if (reward === undefined || reward < 0) continue
    const info = metrics(base)
    if (!info) continue
    const arm = readFileSync(setup, 'utf8').includes('plugin in profile:') ? 'B' : 'A'
    const entry = pairs.get(task) ?? {}
    // Latest run per arm.
    if (!entry[arm] || info.mtime > entry[arm].mtime) entry[arm] = { ...info, reward, job }
    pairs.set(task, entry)
  }
}

const pct = (delta) => `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`
console.log('| task | reward | A steps | B steps | Δsteps | A prompt(M) | B prompt(M) | Δprompt | A uncached | B uncached | Δuncached | A wall | B wall | Δwall |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
const collect = { steps: [], prompt: [], uncached: [], wall: [], output: [] }
for (const task of ids) {
  const entry = pairs.get(task)
  if (!entry?.A || !entry?.B) continue
  const a = entry.A
  const b = entry.B
  const d = (x, y) => (x ? (y - x) / x : 0)
  collect.steps.push(d(a.steps, b.steps))
  collect.prompt.push(d(a.prompt, b.prompt))
  collect.uncached.push(d(a.uncached, b.uncached))
  collect.wall.push(d(a.wall, b.wall))
  collect.output.push(d(a.output, b.output))
  console.log(
    `| ${task} | ${a.reward}/${b.reward} | ${a.steps} | ${b.steps} | ${pct(d(a.steps, b.steps))} | ` +
      `${(a.prompt / 1e6).toFixed(1)} | ${(b.prompt / 1e6).toFixed(1)} | ${pct(d(a.prompt, b.prompt))} | ` +
      `${a.uncached} | ${b.uncached} | ${pct(d(a.uncached, b.uncached))} | ${(a.wall / 60).toFixed(0)}m | ${(b.wall / 60).toFixed(0)}m | ${pct(d(a.wall, b.wall))} |`
  )
}
const median = (values) => {
  const sorted = [...values].sort((x, y) => x - y)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length
console.log(`\n${collect.steps.length} 对（每臂取最近一次运行）：`)
for (const [label, values] of Object.entries(collect)) {
  console.log(`  ${label.padEnd(9)} 中位差 ${pct(median(values))} · 均值差 ${pct(mean(values))} · 插件更低 ${values.filter((v) => v < 0).length}/${values.length}`)
}
