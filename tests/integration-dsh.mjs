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
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as ClientPlugin from '../lib/typesafe-client.js'
import * as LoopGuard from '../lib/loop-guard.js'
import * as SafetyGuard from '../lib/safety-guard.js'
import * as ToolPruner from '../lib/tool-pruner.js'
import * as ResultShaper from '../lib/result-shaper.js'

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
const notices = afterSecond?.contexts ?? afterSecond?.additionalContexts ?? []
check(
  'loop-guard attaches a notice through the real post-execute waterfall',
  notices.length === 1 && notices[0]?.source?.plugin === 'typesafe-loop-guard',
  'contexts=' + notices.length
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

const failed = results.filter((entry) => !entry.ok)
console.log('\n' + (failed.length === 0 ? 'all integration checks passed' : failed.length + ' integration check(s) failed'))
process.exit(failed.length === 0 ? 0 : 1)
