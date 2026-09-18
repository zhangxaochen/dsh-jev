// Measure the shipped pruner defaults end to end: how many tools survive, and
// does minScoreThreshold 2 keep the ones a multi-step intent needs?
import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolPrunerService } from '../lib/tool-pruner.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'

process.env.DSH_JEV_METRICS_PATH ??= join(tmpdir(), 'jev-pruner-defaults-metrics.json')

const key = (() => {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY
  const m = readFileSync(join(homedir(), '.dsh', '.env'), 'utf8').match(/TYPESAFE_API_KEY\s*=\s*(.+)/)
  return m![1].trim()
})()

const TOOLS = [
  { name: 'search_web', description: 'Search the public web and return titles, URLs and snippets' },
  { name: 'fetch_url', description: 'Download a web page and return its text content' },
  { name: 'read_file', description: 'Read a file from the workspace' },
  { name: 'edit_file', description: 'Replace text inside a workspace file' },
  { name: 'run_tests', description: 'Run the project test suite and return its output' },
  { name: 'git_commit', description: 'Create a git commit from the staged changes' },
  { name: 'git_push', description: 'Push local commits to the remote branch' },
  { name: 'sql_query', description: 'Run a read-only SQL query against the analytics database' },
  { name: 'pdf_extract', description: 'Extract text and tables from a PDF document' },
  { name: 'send_slack_message', description: 'Post a message to a Slack channel' },
  { name: 'image_generate', description: 'Generate an image from a text prompt' },
  { name: 'deploy_service', description: 'Deploy the current build to the production cluster' },
]

const intents = [
  ['fix-tests-and-ship', 'The user asked: 搜索这个仓库的测试失败原因，修好断言并提交推送'],
  ['research-then-prd', 'The user asked: 调研竞品并整理成一份 PRD 文档'],
]

for (const [label, intent] of intents) {
  for (const minScoreThreshold of [2, 1]) {
    const client = new TypeSafeClient({ apiKey: key })
    const pruner = new ToolPrunerService(() => client, { maxTools: 8, minScoreThreshold, alwaysRetain: [] })
    const started = Date.now()
    const kept = await pruner.pruneTools(intent, TOOLS as any)
    console.log(
      label + ' | threshold ' + minScoreThreshold + ' | kept ' + kept.length + '/' + TOOLS.length +
        ': ' + kept.map((t) => t.name).join(',') + '  (' + (Date.now() - started) + 'ms)'
    )
  }
}
process.exit(0)
