/**
 * One whole turn's semantic layer, with the real model.
 *
 * Every module is verified live on its own (`verify:live`, `verify:tools`,
 * `verify:shaper`, `verify:pruner`, `verify:router`) and all of them together are
 * verified against a mocked model (`verify:dsh`). Nothing drove every module
 * together with real answers, which is what a real turn does — and what the
 * restart-gated host check would show.
 *
 * Mounts the plugins on a real Cordis runtime with the real prompt/tools/skill
 * services and the real 112-skill catalog, then assembles a prompt and runs a
 * tool result through the post-execute waterfall once each. Reports what each
 * module did and what the whole semantic layer cost.
 *
 * Run: node --experimental-strip-types tests/live-turn.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as ClientPlugin from '../lib/typesafe-client.js'
import * as LoopGuard from '../lib/loop-guard.js'
import * as SafetyGuard from '../lib/safety-guard.js'
import * as ToolPruner from '../lib/tool-pruner.js'
import * as SkillRouter from '../lib/skill-router.js'
import * as ResultShaper from '../lib/result-shaper.js'

// Keep this run out of the operator's live state.
process.env.DSH_JEV_METRICS_PATH ??= join(tmpdir(), 'jev-live-turn-metrics.json')
process.env.DSH_JEV_DECISIONS_PATH ??= join(tmpdir(), 'jev-live-turn-decisions.jsonl')

function loadKey(): string {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY
  const envFile = join(homedir(), '.dsh', '.env')
  if (existsSync(envFile)) {
    const match = readFileSync(envFile, 'utf8').match(/TYPESAFE_API_KEY\s*=\s*(.+)/)
    if (match?.[1]) return match[1].trim()
  }
  throw new Error('TYPESAFE_API_KEY not found')
}

function dshNodeModules(): string | undefined {
  const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh')
  for (const profile of ['desktop', 'web', 'headless', 'tui', 'acp']) {
    const root = join(dshHome, 'profiles', profile, 'node_modules')
    if (existsSync(join(root, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))) return root
  }
  return undefined
}

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

const NOISY = [
  ...Array.from({ length: 300 }, (_, i) => `[build] module src/feature-${i}/index.ts transformed in ${i + 3}ms`),
  'ERROR in src/app.ts:42 TS2345: Argument of type string is not assignable to parameter of type number',
  ...Array.from({ length: 300 }, (_, i) => `[build] chunk assets/bundle-${i}.js emitted ${i + 7}kb`),
].join('\n')

const checks: Array<{ ok: boolean; label: string; detail: string }> = []
function check(label: string, ok: boolean, detail = '') {
  checks.push({ ok, label, detail })
}

async function main(): Promise<void> {
  const nodeModules = dshNodeModules()
  if (!nodeModules) {
    console.log('SKIP: no DSH runtime found; set DSH_HOME to run the whole-turn rehearsal')
    process.exit(0)
  }

  const load = (pkg: string) => import(pathToFileURL(join(nodeModules, '@deepseek-ai', pkg, 'lib', 'index.js')).href)
  const { Context } = await load('cordis')
  const SystemPrompt = await load('dsh-system-prompt')
  const Tools = await load('dsh-tools')
  const Skills = await load('dsh-skill')
  const SkillFs = await load('dsh-skill-filesystem')

  const ctx = new Context()
  ctx.plugin((SystemPrompt as any).default ?? SystemPrompt)
  ctx.plugin((Tools as any).default ?? Tools, { mode: 'native' })
  ctx.plugin((Skills as any).default ?? Skills)
  ctx.plugin((SkillFs as any).default ?? SkillFs)
  ClientPlugin.apply(ctx, { apiKey: loadKey() })
  LoopGuard.apply(ctx, { triggerThreshold: 1 })
  SafetyGuard.apply(ctx, { headless: false })
  ToolPruner.apply(ctx, { maxTools: 6 })
  SkillRouter.apply(ctx, { minCandidates: 3 })
  ResultShaper.apply(ctx, { thresholdChars: 1000, shapeTools: ['run_tests'] })
  await new Promise((resolve) => setTimeout(resolve, 50))

  const tools = ctx.get('tools')
  for (const tool of TOOLS) {
    tools.register({
      name: tool.name,
      description: tool.description,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] },
      async execute() {
        return { ok: true }
      },
    })
  }

  // Count the calls the assembly makes. Overlapping the pruner's and the router's
  // ranking removed one from the critical path without adding any: the property is
  // "same calls, less time", so it is asserted rather than only timed.
  const client = ctx.get('typesafe')
  const callLog: number[] = []
  const originalSystemOne = client.systemOne.bind(client)
  ;(client as any).systemOne = async (req: any, options: any) => {
    callLog.push(Date.now())
    return originalSystemOne(req, options)
  }

  const catalog = await ctx.get('skills').list({})
  // Two halves, two intents: the tool surface is decided against repository work,
  // and the router is exercised with a request the PM catalog can actually serve.
  // A repository intent legitimately yields no skill advice, which is a correct
  // outcome rather than a failure to assert.
  //
  // The intent must be a registered prompt section: `assemble()` takes a context,
  // not sections, so passing sections there is silently ignored and both modules
  // would rank against an empty goal.
  const prompt = ctx.systemPrompt
  const workIntent = '搜索这个仓库的测试失败原因，修好断言并提交推送'
  const skillIntent = '把这份用户调研整理成一份 PRD 文档'

  const disposeWork = prompt.section({ name: 'rehearsal-work', order: 100, text: () => workIntent })
  const callsBefore = callLog.length
  const assembleStarted = Date.now()
  const assembly = await prompt.assemble({})
  const assembleMs = Date.now() - assembleStarted
  const assembleCalls = callLog.length - callsBefore
  const keptTools = (assembly.tools ?? []).map((tool: any) => tool.name ?? tool.function?.name)

  check('the tool surface shrank in the real assembly', assembly.tools.length < TOOLS.length, keptTools.join(','))
  check(
    'the assembly spends two calls and no more',
    assembleCalls === 2,
    assembleCalls + ' call(s): pruner + router'
  )
  check(
    'the intent-appropriate tools survived',
    keptTools.includes('run_tests') && keptTools.includes('edit_file'),
    keptTools.join(',')
  )

  disposeWork()
  const disposeSkill = prompt.section({ name: 'rehearsal-skill', order: 100, text: () => skillIntent })
  const routeStarted = Date.now()
  const routed = await prompt.assemble({})
  const routeMs = Date.now() - routeStarted
  disposeSkill()
  const advice = (routed.contexts ?? []).filter((entry: any) => entry?.name === 'typesafe-skill-router')
  check(
    'a request the catalog can serve gets exactly one skill',
    advice.length === 1,
    String(advice[0]?.text ?? '').slice(0, 60)
  )

  // --- the result half of a turn: the shaper against a large real result ---
  const exec = { name: 'run_tests', args: {}, agent: { id: 'live-turn' }, token: 'x', callId: 'c1', signal: new AbortController().signal }
  const postStarted = Date.now()
  const decision = await tools.postExecute(exec as any, { content: [{ type: 'text', text: NOISY }] } as any)
  const postMs = Date.now() - postStarted
  const shapedText = JSON.stringify(decision.content ?? '')
  check('the shaper acted on a large noisy result', !shapedText.includes('progress') && shapedText.length < NOISY.length, shapedText.length + ' chars')

  console.log('=== one whole turn, live (catalog ' + catalog.length + ', tools ' + TOOLS.length + ') ===')
  console.log('work intent:  ' + workIntent)
  console.log(
    'assemble: ' + assembleMs + 'ms / ' + assembleCalls + ' call(s) -> ' + TOOLS.length + ' tools to ' +
      assembly.tools.length + ' (' + keptTools.join(',') + ')'
  )
  console.log('skill intent: ' + skillIntent + ' -> ' + advice.length + ' advice in ' + routeMs + 'ms')
  console.log('post-execute: ' + postMs + 'ms -> ' + NOISY.length + ' to ' + shapedText.length + ' chars')

  // The budget is checked with the others: adding it after the loop meant it was
  // never printed and never counted, so a breach went unreported.
  const budgetMs = 15000
  const total = assembleMs + routeMs + postMs
  check('the semantic layer fits a practical turn budget', total < budgetMs, total + 'ms of ' + budgetMs + 'ms')

  let failures = 0
  for (const entry of checks) {
    if (!entry.ok) failures += 1
    console.log((entry.ok ? 'ok   ' : 'FAIL ') + entry.label + (entry.detail ? '  (' + entry.detail + ')' : ''))
  }

  console.log(
    '\nsemantic overhead this turn: ' + total + 'ms (' + assembleMs + ' work assemble + ' + routeMs +
      ' skill assemble + ' + postMs + ' post-execute)'
  )
  console.log(failures === 0 ? 'all whole-turn checks passed' : failures + ' whole-turn check(s) failed')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('whole-turn rehearsal failed:', err)
  process.exit(1)
})
