/**
 * Router cost probe: what does bounding the candidate set buy, and what does it cost?
 *
 * `maxCandidates` defaults to 0 (no shortlist) because the shortlist is lexical and a
 * request whose language differs from the catalogue's would lose the correct skill. Plan
 * item 3.1 fixed the case that was blamed on that risk, so the trade-off has to be
 * re-measured: latency against hit rate at 0 / 20 / 40 candidates on the labelled cases.
 *
 * Run: node --experimental-strip-types tests/probe-router-cost.ts
 * Writes docs/calibration/probe-<date>-router-cost.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillRouterService } from '../lib/skill-router.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'
import { loadSkillCatalog, ROUTER_CASES } from './ranking-cases.ts'

process.env.DSH_JEV_METRICS_PATH ??= join(tmpdir(), 'jev-probe-router-cost-metrics.json')
process.env.DSH_JEV_DECISIONS_PATH ??= join(tmpdir(), 'jev-probe-router-cost-decisions.jsonl')

const LIMITS = [0, 20, 40]

/** Mirror the shipped shortlist so its own input can be reported, not guessed. */
function shortlistWords(intent: string): string[] {
  return intent.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []
}

function loadKey(): string {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY
  const envFile = join(homedir(), '.dsh', '.env')
  if (existsSync(envFile)) {
    const match = readFileSync(envFile, 'utf8').match(/TYPESAFE_API_KEY\s*=\s*(.+)/)
    if (match?.[1]) return match[1].trim()
  }
  throw new Error('TYPESAFE_API_KEY not found')
}

interface Row {
  caseId: string
  limit: number
  candidatesSent: number
  picked: string
  score?: number
  confidence?: number
  ok: boolean
  latencyMs: number
  error?: string
}

async function main(): Promise<void> {
  // The client caches identical payloads for 30s by default, and two limits that produce
  // the same question set produce the same payload - which made the first run of this
  // probe report 2ms "latency" for a network call it never made.
  const client = new TypeSafeClient({ apiKey: loadKey(), cacheTtlMs: 0 })

  // Count the questions the router actually sent: the guard means a limit is not always
  // the number of questions, and reporting the nominal cap would overstate the saving.
  let questionsSent = 0
  const originalSystemOne = client.systemOne.bind(client)
  ;(client as any).systemOne = async (request: any, options: any) => {
    questionsSent = Object.keys(request?.questions ?? {}).length
    return originalSystemOne(request, options)
  }
  const catalog = await loadSkillCatalog()
  if (!catalog) {
    console.log('SKIP: no DSH runtime found; set DSH_HOME to run this probe')
    process.exit(0)
  }

  console.log('catalogue ' + catalog.length + ' entries; eligible depends on the router config')
  const rows: Row[] = []
  for (const testCase of ROUTER_CASES) {
    const words = shortlistWords(testCase.intent)
    console.log(`\n[${testCase.id}] shortlist words: ${words.length ? words.join(',') : '(none — every overlap scores 0)'}`)
    for (const limit of LIMITS) {
      const router = new SkillRouterService(() => client, { maxCandidates: limit })
      const started = Date.now()
      try {
        const best = await router.route(testCase.intent, catalog)
        const ok = Boolean(best && testCase.expect.test(best.name))
        rows.push({
          caseId: testCase.id,
          limit,
          candidatesSent: questionsSent,
          picked: best?.name ?? '(none)',
          score: best?.score,
          confidence: best?.confidence,
          ok,
          latencyMs: Date.now() - started,
        })
        console.log(
          `  maxCandidates=${String(limit).padStart(2)} -> ${ok ? 'PASS' : 'FAIL'} ${best?.name ?? '(none)'}` +
            ` (${questionsSent} questions, score ${best?.score}, conf ${best?.confidence}) in ${Date.now() - started}ms`
        )
      } catch (error) {
        rows.push({
          caseId: testCase.id,
          limit,
          candidatesSent: questionsSent,
          picked: '(error)',
          ok: false,
          latencyMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        })
        console.log(`  maxCandidates=${String(limit).padStart(2)} -> ERROR ${error}`)
      }
    }
  }

  const summary = LIMITS.map((limit) => {
    const atLimit = rows.filter((row) => row.limit === limit)
    const latencies = atLimit.map((row) => row.latencyMs)
    return {
      limit,
      hits: atLimit.filter((row) => row.ok).length,
      cases: atLimit.length,
      latencyMeanMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      latencyMedianMs: latencies.length ? [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)] : 0,
      candidatesSent: atLimit[0]?.candidatesSent,
      late: atLimit.filter((row) => row.picked !== '(none)' && !row.ok).map((row) => row.caseId + ':' + row.picked),
    }
  })

  const report = {
    ranAt: new Date().toISOString(),
    catalogSize: catalog.length,
    limits: LIMITS,
    note: 'maxCandidates=0 sends the whole eligible catalogue; the shortlist keeps catalogue order and is lexical.',
    summary,
    rows,
  }
  const outDir = join(process.cwd(), 'docs', 'calibration')
  mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  const outFile = join(outDir, `probe-${stamp}-router-cost.json`)
  writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8')

  console.log('\nmaxCandidates  cases  hits  mean  median  missed')
  for (const entry of summary) {
    console.log(
      `${String(entry.limit).padStart(13)} ${String(entry.cases).padStart(6)} ${String(entry.hits).padStart(5)} ` +
        `${String(entry.latencyMeanMs).padStart(5)}ms ${String(entry.latencyMedianMs).padStart(6)}ms  ${entry.late.join(' ') || '-'}`
    )
  }
  console.log('\nwrote ' + outFile)
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    process.exit(1)
  }
)
