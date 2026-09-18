/**
 * Live verification for the semantic skill router.
 *
 * The router had only service-level coverage with a mocked client, so two things
 * were never measured: whether it picks a relevant skill out of the real catalog
 * (112 entries on this machine), and whether a request carrying one question per
 * skill finishes inside the timeout the shipped service uses for advice.
 *
 * Needs a DSH runtime to read the catalog; skips with exit 0 when absent.
 *
 * Run: node --experimental-strip-types tests/live-router.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SkillRouterService } from '../lib/skill-router.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'

// Keep this run out of the operator's live state.
process.env.DSH_JEV_METRICS_PATH ??= join(tmpdir(), 'jev-live-router-metrics.json')
process.env.DSH_JEV_DECISIONS_PATH ??= join(tmpdir(), 'jev-live-router-decisions.jsonl')

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
    if (existsSync(join(root, '@deepseek-ai', 'dsh-skill', 'lib', 'index.js'))) return root
  }
  return undefined
}

interface Case {
  id: string
  intent: string
  /** The picked skill's name must match this. */
  expect: RegExp
  /** A measured miss that is documented rather than expected to pass. */
  knownMiss?: boolean
}

const CASES: Case[] = [
  { id: 'write-a-prd', intent: '把这份用户调研整理成一份 PRD 文档', expect: /prd/i },
  { id: 'split-into-stories', intent: '把这个功能拆成用户故事并写出验收标准', expect: /user-story/i },
  { id: 'competitor-teardown', intent: '给这三个竞品做一份对比分析', expect: /competitive|battle-card|company-intel|market/i },
  { id: 'pricing-change', intent: '评估这次定价调整该不该上线', expect: /pricing/i },
  { id: 'design-a-workflow', intent: '帮我设计一个多 agent 协作的工作流', expect: /agent-orchestration|orchestration/i },
  { id: 'swot', intent: '对这个新产品做一次 SWOT 分析', expect: /swot/i },
  // Cross-language miss: the request names the artifact in Chinese while the
  // skill is English, and the model prefers a plausible writing skill.
  // Documented in docs/calibration.md §11 rather than expected to pass.
  { id: 'press-release', intent: '为这次发布写一份新闻稿', expect: /press-release/i, knownMiss: true },
]

async function main(): Promise<void> {
  const nodeModules = dshNodeModules()
  if (!nodeModules) {
    console.log('SKIP: no DSH runtime found; set DSH_HOME to run the router checks')
    process.exit(0)
  }

  const { Context } = await import(pathToFileURL(join(nodeModules, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href)
  const load = (pkg: string) => import(pathToFileURL(join(nodeModules, '@deepseek-ai', pkg, 'lib', 'index.js')).href)
  const SystemPrompt = await load('dsh-system-prompt')
  const Skills = await load('dsh-skill')
  const SkillFs = await load('dsh-skill-filesystem')

  const ctx = new Context()
  ctx.plugin(SystemPrompt.default ?? SystemPrompt)
  ctx.plugin(Skills.default ?? Skills)
  ctx.plugin(SkillFs.default ?? SkillFs)
  await new Promise((resolve) => setTimeout(resolve, 50))

  const catalog = await ctx.get('skills').list({})
  console.log('=== skill router, live (catalog ' + catalog.length + ') ===')

  const client = new TypeSafeClient({ apiKey: loadKey() })
  let failures = 0
  let skipped = 0
  let known = 0

  for (const testCase of CASES) {
    const hasCandidate = catalog.some((skill: any) => testCase.expect.test(skill.name))
    if (!hasCandidate) {
      console.log('SKIP [' + testCase.id + '] no catalog entry matches ' + testCase.expect)
      skipped += 1
      continue
    }

    const router = new SkillRouterService(() => client, {})
    const started = Date.now()
    let best: Awaited<ReturnType<SkillRouterService['route']>>
    try {
      best = await router.route(testCase.intent, catalog)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // A timeout here means the shipped advice path would never fire: it uses
      // the client's short advisory timeout for a request carrying one question
      // per skill.
      console.log('FAIL [' + testCase.id + '] threw after ' + (Date.now() - started) + 'ms: ' + message)
      failures += 1
      continue
    }

    const latency = Date.now() - started
    const ok = Boolean(best && testCase.expect.test(best.name))
    if (!ok && testCase.knownMiss) known += 1
    else if (!ok) failures += 1
    console.log(
      (ok ? 'PASS ' : testCase.knownMiss ? 'KNOWN' : 'FAIL ') +
        '[' + testCase.id + '] picked ' + (best?.name ?? '(none)') +
        ' (score ' + best?.score + ', confidence ' + best?.confidence + ') in ' + latency + 'ms' +
        (ok || !testCase.knownMiss ? '' : ' — documented miss')
    )
  }

  console.log(
    failures === 0
      ? '\nAll router cases behaved as expected' + (known > 0 ? ' (' + known + ' documented miss)' : '') + (skipped > 0 ? ' (' + skipped + ' skipped)' : '') + '.'
      : '\n' + failures + ' case(s) misbehaved' + (known > 0 ? ', ' + known + ' documented miss' : '') + (skipped > 0 ? ', ' + skipped + ' skipped' : '') + '.'
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('live router verification failed:', err)
  process.exit(1)
})
