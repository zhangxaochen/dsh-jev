/**
 * Live verification for the rewritten result shaper.
 *
 * The design was measured with throwaway probes (docs/calibration.md §9.4); this
 * drives the shipped code path — clustering, per-cluster question building,
 * parsing, keep/drop, rebuild — against the live model.
 *
 * Run: node --experimental-strip-types tests/live-shaper.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResultShaperService } from '../lib/result-shaper.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'

// Keep this run out of the operator's live state.
process.env.DSH_JEV_METRICS_PATH ??= join(tmpdir(), 'jev-live-shaper-metrics.json')
process.env.DSH_JEV_DECISIONS_PATH ??= join(tmpdir(), 'jev-live-shaper-decisions.jsonl')

function loadKey(): string {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY
  const envFile = join(homedir(), '.dsh', '.env')
  if (existsSync(envFile)) {
    const match = readFileSync(envFile, 'utf8').match(/TYPESAFE_API_KEY\s*=\s*(.+)/)
    if (match?.[1]) return match[1].trim()
  }
  throw new Error('TYPESAFE_API_KEY not found')
}

const client = new TypeSafeClient({ apiKey: loadKey() })

const buildLog = [
  ...Array.from({ length: 300 }, (_, i) => `[build] module src/feature-${i}/index.ts transformed in ${i + 3}ms`),
  'ERROR in src/app.ts:42 TS2345: Argument of type string is not assignable to parameter of type number',
  '    at Object.<anonymous> (src/app.ts:42:11)',
  ...Array.from({ length: 300 }, (_, i) => `[build] chunk assets/bundle-${i}.js emitted ${i + 7}kb`),
].join('\n')

const dependencyTree = [
  ...Array.from({ length: 300 }, (_, i) => `│   ├── pkg-${i}@1.${i}.0 resolved from registry`),
  'npm WARN deprecated left-pad@1.3.0: use String.prototype.padStart instead',
  ...Array.from({ length: 300 }, (_, i) => `│   ├── lib-${i}@2.${i}.1 resolved from registry`),
].join('\n')

const testRun = [
  ...Array.from({ length: 200 }, (_, i) => `ok ${i} - test case number ${i}`),
  'not ok 201 - guard rejects a destructive command',
  '  AssertionError: expected allow to equal deny',
  ...Array.from({ length: 200 }, (_, i) => `ok ${i + 202} - test case number ${i + 202}`),
].join('\n')

const pureNoise = Array.from({ length: 900 }, () => 'downloading... 100%').join('\n')

interface Scenario {
  id: string
  content: string
  expectShaped: boolean
  mustKeep: string[]
  mustDrop: string[]
}

const SCENARIOS: Scenario[] = [
  {
    id: 'build-log',
    content: buildLog,
    expectShaped: true,
    mustKeep: ['ERROR in src/app.ts:42'],
    mustDrop: ['[build] module src/feature-7/index.ts'],
  },
  {
    id: 'dependency-tree',
    content: dependencyTree,
    expectShaped: true,
    mustKeep: ['npm WARN deprecated left-pad@1.3.0'],
    mustDrop: ['pkg-7@1.7.0 resolved'],
  },
  {
    id: 'test-run',
    content: testRun,
    expectShaped: true,
    mustKeep: ['not ok 201', 'AssertionError: expected allow to equal deny'],
    mustDrop: ['ok 7 - test case number 7'],
  },
  {
    id: 'pure-noise',
    content: pureNoise,
    expectShaped: false,
    mustKeep: [],
    mustDrop: [],
  },
]

async function main(): Promise<void> {
  let failures = 0
  console.log('=== result shaper, live ===')

  for (const scenario of SCENARIOS) {
    const shaper = new ResultShaperService(() => client, {})
    const started = Date.now()
    let shaped: Awaited<ReturnType<ResultShaperService['shape']>>
    try {
      shaped = await shaper.shape(scenario.content, 'pwsh')
    } catch (err) {
      console.log('FAIL [' + scenario.id + '] threw: ' + (err instanceof Error ? err.message : String(err)))
      failures += 1
      continue
    }
    const latency = Date.now() - started
    const problems: string[] = []

    if (scenario.expectShaped && !shaped) problems.push('expected shaping, got passthrough')
    if (!scenario.expectShaped && shaped) problems.push('expected passthrough, got shaping')
    if (shaped) {
      for (const needle of scenario.mustKeep) {
        if (!shaped.text.includes(needle)) problems.push('dropped something it had to keep: ' + needle)
      }
      for (const needle of scenario.mustDrop) {
        if (shaped.text.includes(needle)) problems.push('kept something it had to drop: ' + needle)
      }
      if (shaped.text.length >= scenario.content.length) problems.push('shaped text is not smaller')
    }

    if (problems.length > 0) failures += 1
    console.log(
      (problems.length === 0 ? 'PASS ' : 'FAIL ') +
        '[' + scenario.id + '] ' +
        (shaped
          ? scenario.content.length + ' -> ' + shaped.text.length + ' chars, kept ' + shaped.keptClusters +
            ' cluster(s), dropped ' + shaped.droppedLines + ' line(s)'
          : 'declined (nothing worth keeping)') +
        ', ' + latency + 'ms'
    )
    for (const problem of problems) console.log('       ' + problem)
  }

  console.log(failures === 0 ? '\nAll shaper scenarios behaved as expected.' : '\n' + failures + ' scenario(s) misbehaved.')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('live shaper verification failed:', err)
  process.exit(1)
})
