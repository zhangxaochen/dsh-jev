/**
 * Integration check against the real DSH runtime.
 *
 * Unit tests drive the plugins with hand-written fake contexts, which cannot
 * catch a wrong event name, a wrong argument order or a decision shape the real
 * dispatcher rejects. This script mounts the plugins on a real Cordis context
 * and drives the real waterfalls instead.
 *
 * It needs the DSH runtime on disk and skips cleanly when it is absent, so CI
 * (which has no DSH installed) stays green.
 *
 * Run: node tests/integration-dsh.mjs
 */
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Verification runs must not touch the operator's live metrics file: the path is
// resolved on first use, so setting it here is enough.
process.env.DSH_JEV_METRICS_PATH ??= joinPath(tmpdir(), 'jev-integration-metrics.json')
process.env.DSH_JEV_DECISIONS_PATH ??= joinPath(tmpdir(), 'jev-integration-decisions.jsonl')

import * as ClientPlugin from '../lib/typesafe-client.js'
import * as LoopGuard from '../lib/loop-guard.js'
import * as SafetyGuard from '../lib/safety-guard.js'
import * as ToolPruner from '../lib/tool-pruner.js'
import * as ResultShaper from '../lib/result-shaper.js'
import * as SkillRouter from '../lib/skill-router.js'
import { join as joinPath } from 'node:path'

/** Locate the cordis package the host actually loaded. */
function findCordis() {
  const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh')
  const candidates = [
    join(dshHome, 'profiles', 'desktop', 'node_modules'),
    join(dshHome, 'profiles', 'web', 'node_modules'),
    join(dshHome, 'profiles', 'headless', 'node_modules'),
    join(dshHome, 'profiles', 'node_modules'),
    join(dshHome, 'node_modules'),
  ]
  for (const root of candidates) {
    const entry = join(root, '@deepseek-ai', 'cordis', 'lib', 'index.js')
    if (existsSync(entry)) return entry
  }
  return undefined
}

const cordisPath = findCordis()
if (!cordisPath) {
  console.log('SKIP: no DSH runtime found; set DSH_HOME to run the integration checks')
  process.exit(0)
}

const { Context } = await import(pathToFileURL(cordisPath).href)

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail })
  console.log((condition ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''))
}

/** Answer the two question sets the guards ask, based on the question ids. */
async function answersFor(req) {
  const ids = Object.keys(req.questions ?? {})
  if (ids.every((id) => id.startsWith('skill_'))) {
    // Skill router: score every candidate, so the router can pick one.
    const answers = {}
    for (const id of ids) answers[id] = { type: 'score', score: 2, confidence: 0.9, probabilities: {} }
    return answers
  }
  if (ids.every((id) => id.startsWith('kind_'))) {
    // Result shaper: classify each line shape. The sample travels inside the
    // question, so the mock reads it from there - exactly as the live model does.
    const answers = {}
    for (const id of ids) {
      const sample = String(req.questions[id]?.instructions ?? '')
      const choice = /ERROR|error|AssertionError|not ok|stack:/.test(sample) ? 'failure' : 'routine_progress'
      answers[id] = { type: 'choice', choice, confidence: 0.99, probabilities: { [choice]: 0.99 } }
    }
    return answers
  }
  if (ids.includes('stuck_severity')) {
    return {
      has_progress: { type: 'noul', noul: 0.1 },
      stuck_severity: { type: 'score', score: 1.85, confidence: 0.8, probabilities: { '0': 0, '1': 0.14, '2': 0.86 } },
    }
  }
  return {
    is_destructive: { type: 'noul', noul: 0.01 },
    is_exfiltration: { type: 'noul', noul: 0.01 },
    credential_kind: { type: 'choice', choice: 'none', confidence: 0.9, probabilities: { none: 0.99 } },
    is_jailbreak: { type: 'noul', noul: 0.01 },
    risk_score: { type: 'score', score: 0.02, confidence: 0.9, probabilities: { '0': 0.98, '1': 0.02, '2': 0 } },
  }
}

const ctx = new Context()
ctx.plugin(ClientPlugin, { mockHandler: answersFor })
LoopGuard.apply(ctx, { triggerThreshold: 2, cooldownSteps: 2 })
SafetyGuard.apply(ctx, { headless: false })
ToolPruner.apply(ctx, { maxTools: 2 })
// Mounted although disabled by default: its pre-step bookkeeping must still not
// interfere with the step decision.
ResultShaper.apply(ctx, {})

// The client service must be reachable the way the guards look it up. Cordis
// starts a plugin fiber asynchronously, so let it settle first.
await new Promise((resolve) => setTimeout(resolve, 0))
const client = ctx.get('typesafe')
check('client service is resolvable through ctx.get', client instanceof ClientPlugin.TypeSafeClient)
check(
  'the client plugin also sets ctx.typesafe, the fallback the guards use',
  ctx.typesafe instanceof ClientPlugin.TypeSafeClient
)

// 1. Real post-execute waterfall: a stuck trajectory must produce a notice.
const exec = { name: 'bash', args: { command: 'npm test' }, agent: { id: 'integration' } }
const passthrough = async () => ({ kind: 'accept', action: 'accept' })
await ctx.waterfall('tools/post-execute', exec, { content: 'first failure' }, passthrough)
const afterSecond = await ctx.waterfall('tools/post-execute', exec, { content: 'second failure' }, passthrough)
// Assert the field the tools service actually merges, not whichever key exists.
const notices = afterSecond?.additionalContexts ?? []
check(
  'loop-guard attaches a notice through the real post-execute waterfall',
  notices.length === 1 && notices[0]?.source?.plugin === 'typesafe-loop-guard',
  'additionalContexts=' + notices.length
)

// 2. Real pre-execute waterfall: the deterministic envelope must deny.
const dangerous = { name: 'pwsh', args: { command: 'rm -rf / --no-preserve-root' } }
const allow = async () => ({ kind: 'allow', action: 'allow' })
const preDecision = await ctx.waterfall('tools/pre-execute', dangerous, allow)
check(
  'safety-guard denies through the real pre-execute waterfall',
  preDecision?.kind === 'deny' && /filesystem-root-delete/.test(preDecision?.reason ?? ''),
  'kind=' + preDecision?.kind
)

const safeDecision = await ctx.waterfall('tools/pre-execute', { name: 'pwsh', args: { command: 'npm test' } }, allow)
check('safety-guard lets a benign call reach the downstream listener', safeDecision?.kind === 'allow')

// 3. Every plugin must pass the agent/pre-step decision through untouched.
//    A waterfall listener that forgets to call next() returns undefined and the
//    agent loop loses the decision it awaits, which is a crash, not a warning.
const stepDecision = { kind: 'enter', messages: ['kept'] }
const afterPreStep = await ctx.waterfall('agent/pre-step', { agent: { id: 'integration' }, messages: [], step: 1 }, async () => stepDecision)
check(
  'agent/pre-step keeps the downstream decision when every plugin is mounted',
  afterPreStep?.kind === 'enter' && afterPreStep?.messages?.[0] === 'kept',
  'result=' + JSON.stringify(afterPreStep)
)

// 4. Real system-prompt/assemble waterfall: pruning must survive the invariant.
const assembly = {
  sections: [{ name: 'persona', text: 'you are a careful engineer working on the repository' }],
  contexts: [],
  tools: [
    { name: 'search_web', description: 'search the web' },
    { name: 'send_slack_message', description: 'post to slack' },
    { name: 'read_file', description: 'read a file' },
    { name: 'write_to_file', description: 'write a file' },
  ],
  variables: {},
}
// The pruner rewrites `assembly.tools` in place, so the original length has to
// be captured before the waterfall runs.
const toolsBefore = assembly.tools.length
const assembled = await ctx.waterfall('system-prompt/assemble', assembly, {}, async () => assembly)
check(
  'tool-pruner rewrites the assembled tool surface in the real waterfall',
  Array.isArray(assembled?.tools) && assembled.tools.length < toolsBefore,
  'tools ' + toolsBefore + ' -> ' + assembled?.tools?.length
)
check(
  'the assembled result keeps the fields the harness invariant requires',
  typeof assembled.sections?.[0]?.text === 'string' && Array.isArray(assembled.contexts)
)

// 5. Service-level pass: run one tool call through the real Tools service so its
//    decision normalization and invariants execute, not just the bare waterfall.
try {
  const nm = joinPath(process.env.USERPROFILE ?? homedir(), '.dsh', 'profiles', 'desktop', 'node_modules')
  const loadPkg = (pkg) => import(pathToFileURL(joinPath(nm, pkg, 'lib', 'index.js')).href)
  const SystemPrompt = await loadPkg('@deepseek-ai/dsh-system-prompt')
  const Tools = await loadPkg('@deepseek-ai/dsh-tools')

  const serviceCtx = new Context()
  serviceCtx.plugin(SystemPrompt.default ?? SystemPrompt)
  serviceCtx.plugin(Tools.default ?? Tools, { mode: 'native' })
  // The client must live in the scope the guards resolve from.
  ClientPlugin.apply(serviceCtx, { mockHandler: answersFor })
  const repetitive = [
    ...Array.from({ length: 40 }, () => 'progress: chunk ok'),
    'IMPORTANT error at src/a.ts',
    'IMPORTANT detail',
    'stack: at run (src/a.ts:12)',
    ...Array.from({ length: 40 }, () => 'progress: chunk ok'),
  ].join('\n')
  ResultShaper.apply(serviceCtx, {
    thresholdChars: 10,
    shapeTools: ['noisy_tool'],
    linesPerSegment: 3,
    maxSegments: 24,
  })

  await new Promise((resolve) => setTimeout(resolve, 10))

  const tools = serviceCtx.get('tools')
  tools.register({
    name: 'noisy_tool',
    description: 'integration probe',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] },
    async execute() {
      return { ok: true }
    },
  })

  const created = tools.createExecution({
    name: 'noisy_tool',
    arguments: {},
    signal: new AbortController().signal,
  })
  const prepared = await tools.prepareExecution(created.exec, (p) => p)
  check('the real service prepares the probe call for dispatch', prepared.kind === 'dispatch', 'kind=' + prepared.kind)

  const exec = prepared.exec ?? prepared
  const afterPost = await tools.postExecute(exec, { content: [{ type: 'text', text: repetitive }] })
  const shapedText = afterPost?.content?.[0]?.text ?? ''
  check(
    'the service accepts the shaper decision and keeps the invariants intact',
    Array.isArray(afterPost?.content) && shapedText.length < repetitive.length,
    'chars ' + repetitive.length + ' -> ' + shapedText.length
  )
  check(
    'the shaped content keeps the informative lines and marks what it dropped',
    shapedText.includes('IMPORTANT error at src/a.ts') &&
      /dropped by TypeSafe result shaper/.test(shapedText),
    'marker=' + /dropped by TypeSafe result shaper/.test(shapedText)
  )
} catch (err) {
  check('service-level pass runs', false, err instanceof Error ? err.message : String(err))
}

// 6. A denial must stop the call, not merely return a decision: through the real
//    service the tool must never execute, and the failure must reach the caller.
try {
  const nm = joinPath(process.env.USERPROFILE ?? homedir(), '.dsh', 'profiles', 'desktop', 'node_modules')
  const loadPkg = (pkg) => import(pathToFileURL(joinPath(nm, pkg, 'lib', 'index.js')).href)
  const SystemPrompt = await loadPkg('@deepseek-ai/dsh-system-prompt')
  const Tools = await loadPkg('@deepseek-ai/dsh-tools')

  const denyCtx = new Context()
  denyCtx.plugin(SystemPrompt.default ?? SystemPrompt)
  denyCtx.plugin(Tools.default ?? Tools, { mode: 'native' })
  ClientPlugin.apply(denyCtx, {
    mockHandler: async () => ({
      is_destructive: { type: 'noul', noul: 0.2 },
      is_exfiltration: { type: 'noul', noul: 0.05 },
      credential_kind: { type: 'choice', choice: 'none', confidence: 0.9, probabilities: { none: 0.98 } },
      is_jailbreak: { type: 'noul', noul: 0.05 },
      risk_score: { type: 'score', score: 0.2, confidence: 0.9, probabilities: { '0': 0.85, '1': 0.1, '2': 0.05 } },
    }),
  })
  SafetyGuard.apply(denyCtx, { guardedTools: ['danger_tool'] })
  await new Promise((resolve) => setTimeout(resolve, 10))

  const denyTools = denyCtx.get('tools')
  let executed = 0
  denyTools.register({
    name: 'danger_tool',
    description: 'destructive probe',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] },
    async execute() {
      executed += 1
      return { ok: true }
    },
  })

  // A permissive plugin registered after ours. The monotonic guard must deny
  // before the extensible waterfall, so this listener never even runs.
  let permissiveRan = 0
  denyCtx.on('tools/pre-execute', async () => {
    permissiveRan += 1
    return { kind: 'allow', action: 'allow' }
  })

  const denied = await denyTools.prepareExecution(
    denyTools.createExecution({
      name: 'danger_tool',
      arguments: { command: 'rm -rf / --no-preserve-root' },
      signal: new AbortController().signal,
    }).exec,
    (p) => p
  )
  // The security property is not "a deny decision was produced" but "the tool
  // body never ran": executed must stay zero.
  check(
    'a denied call never reaches the tool, and the caller sees the policy reason',
    denied.kind === 'post-result' &&
      denied.result?.isError === true &&
      /filesystem-root-delete/.test(denied.result?.error?.message ?? '') &&
      executed === 0,
    'kind=' + denied.kind + ' executed=' + executed
  )
  check(
    'a later permissive listener cannot allow what the deterministic envelope denies',
    permissiveRan === 0 && executed === 0,
    'permissive listener runs=' + permissiveRan
  )
} catch (err) {
  check('service-level denial pass runs', false, err instanceof Error ? err.message : String(err))
}

// 7. The loop notice must reach the caller through the real service, not only
//    through a bare waterfall.
try {
  const nm = joinPath(process.env.USERPROFILE ?? homedir(), '.dsh', 'profiles', 'desktop', 'node_modules')
  const loadPkg = (pkg) => import(pathToFileURL(joinPath(nm, pkg, 'lib', 'index.js')).href)
  const SystemPrompt = await loadPkg('@deepseek-ai/dsh-system-prompt')
  const Tools = await loadPkg('@deepseek-ai/dsh-tools')

  const loopCtx = new Context()
  loopCtx.plugin(SystemPrompt.default ?? SystemPrompt)
  loopCtx.plugin(Tools.default ?? Tools, { mode: 'native' })
  ClientPlugin.apply(loopCtx, {
    mockHandler: async (req) =>
      Object.keys(req.questions ?? {}).includes('stuck_severity')
        ? {
            has_progress: { type: 'noul', noul: 0.1 },
            stuck_severity: { type: 'score', score: 1.85, confidence: 0.8, probabilities: { '0': 0, '1': 0.14, '2': 0.86 } },
          }
        : answersFor(req),
  })
  LoopGuard.apply(loopCtx, { triggerThreshold: 1 })
  await new Promise((resolve) => setTimeout(resolve, 10))

  const loopTools = loopCtx.get('tools')
  loopTools.register({
    name: 'looping_tool',
    description: 'integration probe',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] },
    async execute() {
      return { ok: true }
    },
  })

  const loopCreated = loopTools.createExecution({
    name: 'looping_tool',
    arguments: {},
    agent: { id: 'integration-agent' },
    signal: new AbortController().signal,
  })
  const loopPrepared = await loopTools.prepareExecution(loopCreated.exec, (p) => p)
  const loopResult = await loopTools.postExecute(loopPrepared.exec ?? loopPrepared, {
    content: [{ type: 'text', text: 'error: cannot find module' }],
  })
  const loopContexts = loopResult?.additionalContexts ?? []
  check(
    'the loop notice reaches the caller through the real service',
    loopContexts.length === 1 && loopContexts[0]?.source?.plugin === 'typesafe-loop-guard',
    'contexts=' + loopContexts.length
  )
} catch (err) {
  check('service-level loop-notice pass runs', false, err instanceof Error ? err.message : String(err))
}

// 8. The real system prompt service must accept the pruned assembly.
try {
  const nm = joinPath(process.env.USERPROFILE ?? homedir(), '.dsh', 'profiles', 'desktop', 'node_modules')
  const loadPkg = (pkg) => import(pathToFileURL(joinPath(nm, pkg, 'lib', 'index.js')).href)
  const SystemPrompt = await loadPkg('@deepseek-ai/dsh-system-prompt')
  const Tools = await loadPkg('@deepseek-ai/dsh-tools')

  const promptCtx = new Context()
  promptCtx.plugin(SystemPrompt.default ?? SystemPrompt)
  promptCtx.plugin(Tools.default ?? Tools, { mode: 'native' })
  ClientPlugin.apply(promptCtx, { mockHandler: answersFor })
  ToolPruner.apply(promptCtx, { maxTools: 2 })
  await new Promise((resolve) => setTimeout(resolve, 10))

  const promptTools = promptCtx.get('tools')
  for (const name of ['search_web', 'send_slack', 'read_file', 'write_file']) {
    promptTools.register({
      name,
      description: 'tool ' + name,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] },
      async execute() {
        return { ok: true }
      },
    })
  }

  const assembly = await promptCtx.systemPrompt.assemble({})
  check(
    'the real prompt service accepts the pruned assembly without an invariant failure',
    Array.isArray(assembly.tools) && assembly.tools.length > 0 && assembly.tools.length < 4,
    'tools=' + assembly.tools.map((tool) => tool.name).join(',')
  )
} catch (err) {
  check('service-level assembly pass runs', false, err instanceof Error ? err.message : String(err))
}

// 9. The skill router against the real registry: the catalog shape it consumes,
//    and a single advisory context in the assembled prompt.
try {
  const nm = joinPath(process.env.USERPROFILE ?? homedir(), '.dsh', 'profiles', 'desktop', 'node_modules')
  const loadPkg = (pkg) => import(pathToFileURL(joinPath(nm, pkg, 'lib', 'index.js')).href)
  const SystemPrompt = await loadPkg('@deepseek-ai/dsh-system-prompt')
  const Skills = await loadPkg('@deepseek-ai/dsh-skill')
  const SkillFs = await loadPkg('@deepseek-ai/dsh-skill-filesystem')

  const skillCtx = new Context()
  skillCtx.plugin(SystemPrompt.default ?? SystemPrompt)
  skillCtx.plugin(Skills.default ?? Skills)
  skillCtx.plugin(SkillFs.default ?? SkillFs)
  await new Promise((resolve) => setTimeout(resolve, 20))

  const registry = skillCtx.get('skills')
  const catalog = await registry.list({})
  check(
    'the real skill catalog carries the summary shape the router consumes',
    Array.isArray(catalog) && catalog.every((entry) => typeof entry.name === 'string' && typeof entry.description === 'string'),
    'catalog=' + catalog.length
  )

  ClientPlugin.apply(skillCtx, {
    mockHandler: async (req) => {
      const answers = {}
      for (const id of Object.keys(req.questions ?? {})) {
        answers[id] = { type: 'score', score: 2, confidence: 0.9, probabilities: { '0': 0, '1': 0, '2': 1 } }
      }
      return answers
    },
  })
  SkillRouter.apply(skillCtx, { minCandidates: 3 })
  await new Promise((resolve) => setTimeout(resolve, 10))

  const assembled = await skillCtx.systemPrompt.assemble({})
  const advice = (assembled.contexts ?? []).filter((entry) => entry.name === 'typesafe-skill-router')
  check(
    'the router advises exactly one skill through the real prompt assembly',
    advice.length === 1 && /looks directly applicable/.test(advice[0]?.text ?? ''),
    'entries=' + advice.length
  )

  // A second assembly must replace the advice, never stack it.
  const again = await skillCtx.systemPrompt.assemble({})
  const stacked = (again.contexts ?? []).filter((entry) => entry.name === 'typesafe-skill-router')
  check('assembling again does not stack a second advice entry', stacked.length <= 1, 'entries=' + stacked.length)
} catch (err) {
  check('service-level skill-routing pass runs', false, err instanceof Error ? err.message : String(err))
}

// 10. Every module mounted together: the pruner and the router both hook
//     system-prompt/assemble, and the loop guard and the shaper both hook
//     tools/post-execute. Each effect must survive the presence of the others.
try {
  const nm = joinPath(process.env.USERPROFILE ?? homedir(), '.dsh', 'profiles', 'desktop', 'node_modules')
  const loadPkg = (pkg) => import(pathToFileURL(joinPath(nm, pkg, 'lib', 'index.js')).href)
  const SystemPrompt = await loadPkg('@deepseek-ai/dsh-system-prompt')
  const Tools = await loadPkg('@deepseek-ai/dsh-tools')
  const Skills = await loadPkg('@deepseek-ai/dsh-skill')
  const SkillFs = await loadPkg('@deepseek-ai/dsh-skill-filesystem')

  const allCtx = new Context()
  allCtx.plugin(SystemPrompt.default ?? SystemPrompt)
  allCtx.plugin(Tools.default ?? Tools, { mode: 'native' })
  allCtx.plugin(Skills.default ?? Skills)
  allCtx.plugin(SkillFs.default ?? SkillFs)
  ClientPlugin.apply(allCtx, { mockHandler: answersFor })
  LoopGuard.apply(allCtx, { triggerThreshold: 1 })
  SafetyGuard.apply(allCtx, { headless: false })
  ToolPruner.apply(allCtx, { maxTools: 2 })
  ResultShaper.apply(allCtx, { thresholdChars: 10, shapeTools: ['noisy_tool'], linesPerSegment: 3 })
  SkillRouter.apply(allCtx, { minCandidates: 3 })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const allTools = allCtx.get('tools')
  for (const name of ['search_web', 'send_slack', 'read_file', 'write_file']) {
    allTools.register({
      name,
      description: 'tool ' + name,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] },
      async execute() {
        return { ok: true }
      },
    })
  }

  const toolsBefore = 4
  const allAssembly = await allCtx.systemPrompt.assemble({})
  const routerAdvice = (allAssembly.contexts ?? []).filter((entry) => entry.name === 'typesafe-skill-router')
  check(
    'with every module mounted the pruner still prunes',
    Array.isArray(allAssembly.tools) && allAssembly.tools.length < toolsBefore,
    'tools ' + toolsBefore + ' -> ' + allAssembly.tools.length
  )
  check(
    'with every module mounted the router still advises',
    routerAdvice.length === 1,
    'advice entries=' + routerAdvice.length
  )

  // Both post-execute plugins must contribute to the same decision.
  const allExec = { name: 'noisy_tool', args: {}, agent: { id: 'all-modules' } }
  const noisy = [
    ...Array.from({ length: 60 }, () => 'progress: chunk ok'),
    'IMPORTANT error at src/a.ts',
    ...Array.from({ length: 60 }, () => 'progress: chunk ok'),
  ].join('\n')
  const allResults = await allTools.postExecute(
    { ...allExec, token: 'x', callId: 'c1', signal: new AbortController().signal },
    { content: [{ type: 'text', text: noisy }] }
  )
  check(
    'with every module mounted the shaper still replaces the content',
    Boolean(allResults.content) && !JSON.stringify(allResults.content).includes('progress: chunk ok'),
    'chars=' + JSON.stringify(allResults.content ?? '').length
  )
  check(
    'with every module mounted the loop notice still rides the same decision',
    (allResults.additionalContexts ?? []).some((entry) => entry?.source?.plugin === 'typesafe-loop-guard'),
    'contexts=' + (allResults.additionalContexts ?? []).length
  )
} catch (err) {
  check('all-modules pass runs', false, err instanceof Error ? err.message : String(err))
}

const failed = results.filter((entry) => !entry.ok)
console.log('\n' + (failed.length === 0 ? 'all integration checks passed' : failed.length + ' integration check(s) failed'))
process.exit(failed.length === 0 ? 0 : 1)
