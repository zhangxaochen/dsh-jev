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

const CANDIDATES: ToolDefinitionMinimal[] = [
  { name: 'search_web', description: 'Search the public web and return result titles, URLs and snippets' },
  { name: 'fetch_url', description: 'Download a web page and return its text content' },
  { name: 'git_commit', description: 'Create a git commit from the staged changes' },
  { name: 'git_push', description: 'Push local commits to the remote branch' },
  { name: 'run_tests', description: 'Run the project test suite and return the output' },
  { name: 'read_file', description: 'Read a file from the workspace' },
  { name: 'edit_file', description: 'Replace text inside a workspace file' },
  { name: 'sql_query', description: 'Run a read-only SQL query against the analytics database' },
  { name: 'pdf_extract', description: 'Extract text and tables from a PDF document' },
  { name: 'send_slack_message', description: 'Post a message to a Slack channel' },
  { name: 'send_email', description: 'Send an email through the configured SMTP server' },
  { name: 'image_generate', description: 'Generate an image from a text prompt' },
  { name: 'deploy_service', description: 'Deploy the current build to the production cluster' },
  { name: 'calendar_create', description: 'Create a calendar event' },
]

interface Case {
  id: string
  intent: string
  mustKeep: string[]
  mustDrop: string[]
}

const CASES: Case[] = [
  {
    id: 'research-release-notes',
    intent: 'Search the web for the latest TypeSafe release notes and summarize what changed',
    mustKeep: ['search_web'],
    mustDrop: ['send_slack_message', 'image_generate', 'calendar_create'],
  },
  {
    id: 'ship-the-commit',
    intent: 'Commit the staged changes and push them to the remote branch',
    mustKeep: ['git_commit', 'git_push'],
    mustDrop: ['image_generate', 'calendar_create', 'pdf_extract'],
  },
  {
    id: 'fix-failing-test',
    intent: 'Run the test suite, read the failing assertion and fix the code',
    mustKeep: ['run_tests', 'edit_file'],
    mustDrop: ['send_email', 'image_generate', 'deploy_service'],
  },
  {
    id: 'analytics-question',
    intent: "Query the analytics database for yesterday's signup count",
    mustKeep: ['sql_query'],
    mustDrop: ['deploy_service', 'calendar_create', 'image_generate'],
  },
  {
    id: 'invoice-extraction',
    intent: 'Extract the line items and totals from this PDF invoice',
    mustKeep: ['pdf_extract'],
    mustDrop: ['deploy_service', 'git_push', 'image_generate'],
  },
  {
    id: 'notify-the-team',
    intent: 'Tell the team in Slack that the release is done',
    mustKeep: ['send_slack_message'],
    mustDrop: ['image_generate', 'pdf_extract', 'sql_query'],
  },
]

const MAX_TOOLS = 4

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
