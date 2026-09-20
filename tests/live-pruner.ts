/**
 * Live verification for the tool pruner.
 *
 * The pruner is on by default and removes entries from the model-facing tool
 * surface, so a bad ranking can leave the agent unable to act. It had only an
 * informal script (`live-e2e.ts`) that printed results without asserting
 * anything. These cases are labelled: each names the tools that must survive and
 * the tools that must not, and the run reports any required tool that fell
 * outside the top-K.
 *
 * Run: node --experimental-strip-types tests/live-pruner.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolPrunerService } from '../lib/tool-pruner.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'
import type { ToolDefinitionMinimal } from '../lib/types.js'
import { PRUNER_CANDIDATES, PRUNER_CASES, PRUNER_MAX_TOOLS } from './ranking-cases.ts'

// Keep this run out of the operator's live state.
process.env.DSH_JEV_METRICS_PATH ??= join(tmpdir(), 'jev-live-pruner-metrics.json')
process.env.DSH_JEV_DECISIONS_PATH ??= join(tmpdir(), 'jev-live-pruner-decisions.jsonl')

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

const CANDIDATES: ToolDefinitionMinimal[] = PRUNER_CANDIDATES
const CASES = PRUNER_CASES
const MAX_TOOLS = PRUNER_MAX_TOOLS

async function main(): Promise<void> {
  let failures = 0
  console.log('=== tool pruner, live (maxTools = ' + MAX_TOOLS + ') ===')

  for (const testCase of CASES) {
    const pruner = new ToolPrunerService(() => client, {
      maxTools: MAX_TOOLS,
      minScoreThreshold: 1,
      alwaysRetain: [],
    })

    const started = Date.now()
    let selected: ToolDefinitionMinimal[]
    try {
      selected = await pruner.pruneTools(testCase.intent, CANDIDATES)
    } catch (err) {
      console.log('FAIL [' + testCase.id + '] threw: ' + (err instanceof Error ? err.message : String(err)))
      failures += 1
      continue
    }

    const names = selected.map((tool) => tool.name)
    const problems: string[] = []
    for (const required of testCase.mustKeep) {
      if (!names.includes(required)) problems.push('required tool dropped: ' + required)
    }
    for (const forbidden of testCase.mustDrop) {
      if (names.includes(forbidden)) problems.push('irrelevant tool kept: ' + forbidden)
    }

    if (problems.length > 0) failures += 1
    console.log(
      (problems.length === 0 ? 'PASS ' : 'FAIL ') +
        '[' + testCase.id + '] kept ' + names.join(', ') + '  (' + (Date.now() - started) + 'ms)'
    )
    for (const problem of problems) console.log('       ' + problem)
  }

  console.log(failures === 0 ? '\nAll pruner cases behaved as expected.' : '\n' + failures + ' case(s) misbehaved.')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('live pruner verification failed:', err)
  process.exit(1)
})
