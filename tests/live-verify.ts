/**
 * Live verification for the Phase 1 calibration fix.
 * Run: node --experimental-strip-types tests/live-verify.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { TypeSafeClient, noul, score, scoreConfidence, topBucketProbability } from '../lib/typesafe-client.js'
import { STUCK_SEVERITY_CRITERIA } from '../lib/loop-guard.js'

function loadKey(): string {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY
  const envFile = join(homedir(), '.dsh', '.env')
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/TYPESAFE_API_KEY\s*=\s*(.+)/)
    if (m?.[1]) return m[1].trim()
  }
  throw new Error('TYPESAFE_API_KEY not found')
}

// Keep this run out of the operator's live metrics file.
process.env.DSH_JEV_METRICS_PATH ??= join(tmpdir(), 'jev-live-verify-metrics.json')

const client = new TypeSafeClient({ apiKey: loadKey() })

interface Scenario {
  id: string
  expectFire: boolean
  note: string
  state: unknown
}

const SCENARIOS: Scenario[] = [
  {
    id: 'healthy-mixed-batch',
    expectFire: false,
    note: 'parallel inspection calls (doctor + repo search + code search)',
    state: {
      currentTool: 'pwsh',
      currentArgs: { command: 'gh search repos "jev" --sort stars --limit 30' },
      currentOutputSample: '[{"fullName":"browser-use/jev-ultrafast","stargazersCount":5036}]',
      recentTrajectory: [
        { step: 1, tool: 'pwsh', args: '{"command":"agent-reach doctor --json"}', outputHash: 'a1' },
        { step: 2, tool: 'pwsh', args: '{"command":"gh search repos jev"}', outputHash: 'b2' },
      ],
    },
  },
  {
    id: 'healthy-read-then-pwsh',
    expectFire: false,
    note: 'the exact shape that produced the in-session false positive',
    state: {
      currentTool: 'read',
      currentArgs: { file_path: 'src/typesafe-client.ts' },
      currentOutputSample: 'export class TypeSafeClient { ... }',
      recentTrajectory: [
        { step: 1, tool: 'pwsh', args: '{"command":"git log --oneline -12"}', outputHash: 'c3' },
        { step: 2, tool: 'read', args: '{"file_path":"src/typesafe-client.ts"}', outputHash: 'd4' },
      ],
    },
  },
  {
    id: 'true-loop',
    expectFire: true,
    note: 'same failing command, same output, no new information',
    state: {
      currentTool: 'pwsh',
      currentArgs: { command: 'npm test' },
      currentOutputSample: 'Error: Cannot find module foo',
      recentTrajectory: [
        { step: 1, tool: 'pwsh', args: '{"command":"npm test"}', outputHash: 'same' },
        { step: 2, tool: 'pwsh', args: '{"command":"npm test"}', outputHash: 'same' },
      ],
    },
  },
]

async function main(): Promise<void> {
  let failures = 0
  console.log('=== Phase 1 live verification ===')

  for (const scenario of SCENARIOS) {
    const started = Date.now()
    const answers = await client.systemOne({
      state: scenario.state,
      questions: {
        has_progress: noul(
          'Does the latest tool execution provide new, meaningful progress or fresh information towards solving the task?'
        ),
        stuck_severity: score(
          'Rate how severely this execution sequence is stuck in a repetitive loop or stagnation without progress',
          STUCK_SEVERITY_CRITERIA
        ),
      },
    })
    const latencyMs = Date.now() - started

    const progress: any = answers.has_progress
    const severity: any = answers.stuck_severity
    const progressProb = typeof progress?.noul === 'number' ? progress.noul : undefined
    const pLoop = topBucketProbability(severity)
    const confidence = scoreConfidence(severity)

    const unknown = progressProb === undefined || pLoop === undefined || confidence === undefined
    const fires = !unknown && progressProb < 0.3 && pLoop >= 0.6 && confidence >= 0.5
    const verdict = fires === scenario.expectFire ? 'PASS' : 'FAIL'
    if (verdict === 'FAIL') failures += 1

    console.log(
      verdict + ' [' + scenario.id + '] fires=' + fires + ' (expected ' + scenario.expectFire + ') ' +
        'progress=' + progressProb + ' pLoop=' + pLoop + ' confidence=' + confidence +
        ' score=' + severity?.score + ' ' + latencyMs + 'ms'
    )
    console.log('      ' + scenario.note)
  }

  console.log(failures === 0 ? 'All scenarios behaved as expected.' : failures + ' scenario(s) misbehaved.')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('live verification failed:', err)
  process.exit(1)
})
