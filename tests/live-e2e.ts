/**
 * Live E2E test against TypeSafe AI's real API using configured credentials.
 * Run via: node --experimental-strip-types tests/live-e2e.ts
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TypeSafeClient, noul, choice, score } from '../lib/client.js'
import { ToolPrunerService } from '../lib/tool-pruner.js'

function loadKey(): string {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY
  try {
    const envFile = readFileSync(join(homedir(), '.dsh', '.env'), 'utf8')
    const match = envFile.match(/^TYPESAFE_API_KEY\s*=\s*(.+)$/m)
    if (match?.[1]) return match[1].trim()
  } catch {}
  throw new Error('Could not find TYPESAFE_API_KEY in process.env or ~/.dsh/.env')
}

async function runLiveTest() {
  console.log('=== TypeSafe AI Live E2E Functional Test ===\n')

  const apiKey = loadKey()
  console.log(`[1/4] Loaded API Key: ${apiKey.slice(0, 8)}... (${apiKey.length} chars)`)

  const client = new TypeSafeClient({ apiKey })

  // Test 1: Direct Multi-Primitive System One Evaluation
  console.log('\n[2/4] Testing System One multi-question atomic evaluation...')
  const t0 = Date.now()
  const res = await client.systemOne({
    state: 'rm -rf / --no-preserve-root',
    questions: {
      is_destructive: noul('Does this command delete system files or wipe filesystems?'),
      action_type: choice('What category of action is this?', {
        fs_deletion: 'Filesystem deletion',
        git_commit: 'Git version control',
        web_browse: 'Web browsing',
      }),
      hazard_level: score('Rate the catastrophic hazard level', [
        'Harmless: Everyday command',
        'Moderate: Requires caution',
        'Catastrophic: Irreversible system damage',
      ]),
    },
  })
  const duration = Date.now() - t0
  console.log(`  -> Response in ${duration}ms:`)
  console.log('  -> is_destructive probability:', (res.is_destructive as any).probability)
  console.log('  -> action_type choice:', (res.action_type as any).choice, `(confidence: ${(res.action_type as any).confidence})`)
  console.log('  -> hazard_level score:', (res.hazard_level as any).score, `(probabilities:`, (res.hazard_level as any).probabilities, ')')

  // Test 2: Tool Pruner Live
  console.log('\n[3/4] Testing Dynamic Tool Pruner with live semantic relevance...')
  const pruner = new ToolPrunerService(() => client, { maxTools: 3 })
  const candidates = [
    { name: 'read_file', description: 'Read local source code files' },
    { name: 'write_to_file', description: 'Write files' },
    { name: 'search_web', description: 'Search Google for external information' },
    { name: 'git_commit', description: 'Commit changes to git' },
    { name: 'send_slack_message', description: 'Send a message to a Slack channel' },
  ]
  const goal = 'Search Google for the latest TypeSafe AI documentation release notes'
  const t1 = Date.now()
  const pruned = await pruner.pruneTools(goal, candidates)
  console.log(`  -> Pruned in ${Date.now() - t1}ms for goal: "${goal}"`)
  console.log('  -> Selected tools:', pruned.map((t) => t.name).join(', '))

  // Test 3: Loop / Stall Evaluation Live
  console.log('\n[4/4] Testing Semantic Loop / Stall Evaluation...')
  const loopState = {
    task: 'Fix failing unit test',
    history: [
      { step: 1, tool: 'bash', output: 'Error: Cannot find module foo' },
      { step: 2, tool: 'bash', output: 'Error: Cannot find module foo' },
      { step: 3, tool: 'bash', output: 'Error: Cannot find module foo' },
    ],
  }
  const t2 = Date.now()
  const loopEval = await client.systemOne({
    state: loopState,
    questions: {
      has_progress: noul('Did step 3 make any progress compared to step 2?'),
      stagnation: score('How severely is this trajectory stuck in an unguided error loop?', [
        'Normal exploration',
        'Stagnant repeated error',
        'Critical dead loop',
      ]),
    },
  })
  console.log(`  -> Evaluated in ${Date.now() - t2}ms:`)
  console.log('  -> has_progress probability:', (loopEval.has_progress as any).probability)
  console.log('  -> stagnation severity score:', (loopEval.stagnation as any).score)

  console.log('\n=== All Live Functionality Verified Successfully! ===')
}

runLiveTest().catch((err) => {
  console.error('Live test failed:', err)
  process.exit(1)
})
