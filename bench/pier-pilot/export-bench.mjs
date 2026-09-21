// Export the A/B pilot into the repo: a results file plus the small per-run evidence.
//
// What belongs in git is the part a reader needs to check the claim and reproduce it:
//   - results.json        per-run scores (reward, F2P, P2P) and cost (tokens, steps, wall time)
//   - evidence/<run>/     the harness's own files for each run (tiny)
//   - *.py / *.ps1 / *.mjs  the driver and analysis scripts
// Deliberately excluded: 450 KB agent transcripts per run, 10 MB session archives, 65 MB of
// salvaged patches, container images and node_modules. Those are regenerable or too large, and
// the README says how to get them back.
//
// Usage: node export-bench.mjs [--jobs <dir>] [--out <dir>]
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const PILOT = process.env.PIER_PILOT ?? process.cwd()
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}
const JOBS = flag('--jobs', 'D:/code/deep-swe/jobs')
const OUT = flag('--out', 'bench/pier-pilot')
const DAY = flag('--day', '2026-09-20')
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
    try {
      text += zstdDecompressSync(buffer.subarray(offsets[i], end)).toString('utf8')
    } catch {}
  }
  return text
}

function cost(base) {
  const session = join(base, 'artifacts', 'agent', 'sessions', 'session.v3.jsonl.zstd')
  if (!existsSync(session)) return {}
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
  return { steps, toolCalls: calls, promptTokens: uncached + cached, uncachedInputTokens: uncached, cachedInputTokens: cached, outputTokens: output, reasoningTokens: reasoning }
}

const KEEP = ['verifier/reward.json', 'result.json', 'artifacts/agent/setup.txt', 'artifacts/model.patch', 'artifacts/agent/jev-stats.json', 'artifacts/agent/jev-decisions.jsonl']
const ids = readFileSync(join(PILOT, 'top20-ids.txt'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
const runs = []

for (const job of existsSync(JOBS) ? readdirSync(JOBS) : []) {
  if (!job.startsWith(DAY)) continue
  for (const inner of readdirSync(join(JOBS, job))) {
    const base = join(JOBS, job, inner)
    const setup = join(base, 'artifacts', 'agent', 'setup.txt')
    const rewardFile = join(base, 'verifier', 'reward.json')
    if (!existsSync(setup) || !existsSync(rewardFile)) continue
    let reward
    try {
      reward = JSON.parse(readFileSync(rewardFile, 'utf8'))
    } catch {
      continue
    }
    const arm = readFileSync(setup, 'utf8').includes('plugin in profile:') ? 'B' : 'A'
    const prefix = inner.split('__')[0]
    const task = ids.find((id) => id.startsWith(prefix) || prefix.startsWith(id.slice(0, 28))) ?? prefix
    let wall = null
    const resultFile = join(base, 'result.json')
    if (existsSync(resultFile)) {
      try {
        const payload = JSON.parse(readFileSync(resultFile, 'utf8'))
        wall = Math.round((new Date(payload.finished_at) - new Date(payload.started_at)) / 1000)
      } catch {}
    }
    const run = {
      task,
      arm,
      job,
      run: inner,
      reward: reward.reward ?? null,
      f2pPassed: reward.f2p_passed ?? null,
      f2pTotal: reward.f2p_total ?? null,
      p2pPassed: reward.p2p_passed ?? null,
      p2pTotal: reward.p2p_total ?? null,
      f2pRatio: reward.f2p_total ? +(reward.f2p_passed / reward.f2p_total).toFixed(4) : null,
      wallSeconds: wall,
      ...cost(base),
    }
    runs.push(run)

    // Small evidence files only.
    for (const relative of KEEP) {
      const source = join(base, relative)
      if (!existsSync(source)) continue
      if (statSync(source).size > 200 * 1024) continue
      const target = join(OUT, 'evidence', `${job}__${inner}`, relative.replace('artifacts/', ''))
      mkdirSync(join(target, '..'), { recursive: true })
      copyFileSync(source, target)
    }
  }
}

// One row per task with both arms, control first.
const pairs = ids.map((task) => {
  const of = runs.filter((run) => run.task === task)
  const pick = (arm) => of.filter((run) => run.arm === arm).sort((a, b) => (b.job > a.job ? 1 : -1))[0] ?? null
  const a = pick('A')
  const b = pick('B')
  if (!a || !b) return { task, complete: false, runs: of }
  return {
    task,
    complete: true,
    control: a,
    treatment: b,
    deltaF2pRatio: +((b.f2pRatio ?? 0) - (a.f2pRatio ?? 0)).toFixed(4),
  }
})

mkdirSync(OUT, { recursive: true })
writeFileSync(
  join(OUT, 'results.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), day: DAY, pairs, runs }, null, 2)}\n`
)

for (const file of readdirSync(PILOT)) {
  if (!/\.(py|ps1|mjs)$/.test(file) || file === 'export-bench.mjs') continue
  const source = join(PILOT, file)
  if (!existsSync(source)) continue
  copyFileSync(source, join(OUT, 'scripts', file))
}
const complete = pairs.filter((pair) => pair.complete)
console.log(`pairs complete: ${complete.length}/${ids.length}`)
console.log(`winner B: ${complete.filter((p) => p.deltaF2pRatio > 0.0005).length} · winner A: ${complete.filter((p) => p.deltaF2pRatio < -0.0005).length} · tie: ${complete.filter((p) => Math.abs(p.deltaF2pRatio) <= 0.0005).length}`)
console.log(`runs recorded: ${runs.length}`)
