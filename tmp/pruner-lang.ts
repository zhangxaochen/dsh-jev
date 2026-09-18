// Is the shipped threshold's conservatism a language effect? Same intent, zh vs en,
// with the shipped always-retain list so the numbers match a real deployment.
import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolPrunerService } from '../lib/tool-pruner.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'

process.env.DSH_JEV_METRICS_PATH ??= join(tmpdir(), 'jev-pruner-lang-metrics.json')

const key = (() => {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY
  const m = readFileSync(join(homedir(), '.dsh', '.env'), 'utf8').match(/TYPESAFE_API_KEY\s*=\s*(.+)/)
  return m![1].trim()
})()

// The shipped list retains core file/shell tools, so pruning only ever decides the
// fate of the rest — which is where a research intent lives.
const TOOLS = [
  { name: 'read_file', description: 'Read a file from the workspace' },
  { name: 'edit_file', description: 'Replace text inside a workspace file' },
  { name: 'bash', description: 'Run a shell command' },
  { name: 'search_web', description: 'Search the public web and return titles, URLs and snippets' },
  { name: 'fetch_url', description: 'Download a web page and return its text content' },
  { name: 'run_tests', description: 'Run the project test suite and return its output' },
  { name: 'git_commit', description: 'Create a git commit from the staged changes' },
  { name: 'git_push', description: 'Push local commits to the remote branch' },
  { name: 'sql_query', description: 'Run a read-only SQL query against the analytics database' },
  { name: 'pdf_extract', description: 'Extract text and tables from a PDF document' },
  { name: 'send_slack_message', description: 'Post a message to a Slack channel' },
  { name: 'image_generate', description: 'Generate an image from a text prompt' },
]

const CASES = [
  ['research-zh', '调研竞品并整理成一份 PRD 文档'],
  ['research-en', 'Research the competitors and turn the findings into a PRD document'],
  ['fix-tests-zh', '搜索这个仓库的测试失败原因，修好断言并提交推送'],
  ['fix-tests-en', 'Find why the tests fail in this repository, fix the assertion, then commit and push'],
]

for (const [label, intent] of CASES) {
  const line: string[] = []
  for (const threshold of [2, 1]) {
    const client = new TypeSafeClient({ apiKey: key })
    const pruner = new ToolPrunerService(() => client, { maxTools: 8, minScoreThreshold: threshold })
    const kept = await pruner.pruneTools(intent, TOOLS as any)
    const optional = kept.filter((t) => !['read_file', 'edit_file', 'bash'].includes(t.name)).map((t) => t.name)
    line.push('t' + threshold + ' -> optional kept: ' + (optional.join(',') || '(none)'))
  }
  console.log(label.padEnd(16) + line.join('   |   '))
}
process.exit(0)
