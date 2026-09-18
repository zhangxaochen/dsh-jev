// Scratch: how long does the router's request actually take, and does it pick well?
import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SkillRouterService } from '../lib/skill-router.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'

process.env.DSH_JEV_METRICS_PATH ??= join(tmpdir(), 'jev-router-measure-metrics.json')

const key = (() => {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY
  const envFile = join(homedir(), '.dsh', '.env')
  const m = readFileSync(envFile, 'utf8').match(/TYPESAFE_API_KEY\s*=\s*(.+)/)
  return m![1].trim()
})()

const nm = join(process.env.USERPROFILE!, '.dsh', 'profiles', 'desktop', 'node_modules')
const load = (pkg: string) => import(pathToFileURL(join(nm, '@deepseek-ai', pkg, 'lib', 'index.js')).href)
const { Context } = await load('cordis')
const SystemPrompt = await load('dsh-system-prompt')
const Skills = await load('dsh-skill')
const SkillFs = await load('dsh-skill-filesystem')

const ctx = new Context()
ctx.plugin((SystemPrompt as any).default ?? SystemPrompt)
ctx.plugin((Skills as any).default ?? Skills)
ctx.plugin((SkillFs as any).default ?? SkillFs)
await new Promise((r) => setTimeout(r, 50))
const catalog = await ctx.get('skills').list({})

const intents = [
  ['write-a-prd', '把这份用户调研整理成一份 PRD 文档', /prd/i],
  ['split-into-stories', '把这个功能拆成用户故事并写出验收标准', /user-story/i],
  ['competitor-teardown', '给这三个竞品做一份对比分析', /competitive|battle-card/i],
] as const

for (const timeoutMs of [1]) {
  const client = new TypeSafeClient({ apiKey: key, pathTimeoutMs: 15000 })
  const router = new SkillRouterService(() => client, {})
  for (const [id, intent, expect] of intents) {
    const started = Date.now()
    try {
      const best = await router.route(intent, catalog as any)
      console.log(
        'timeout ' + timeoutMs + 'ms [' + id + '] -> ' + best?.name + ' (score ' + best?.score +
          ', conf ' + best?.confidence + ') in ' + (Date.now() - started) + 'ms' +
          ' | expected ' + expect + ' | ' + (best && expect.test(best.name) ? 'OK' : 'WRONG')
      )
    } catch (err) {
      console.log('timeout ' + timeoutMs + 'ms [' + id + '] threw after ' + (Date.now() - started) + 'ms: ' + (err as Error).message)
    }
  }
}

// Would a bounded candidate set be faster and still correct?
const scored = catalog.map((skill: any) => ({
  skill,
  overlap: intentOverlap('把这份用户调研整理成一份 PRD 文档', skill.name + ' ' + skill.description),
}))
function intentOverlap(intent: string, text: string): number {
  const words = new Set(text.toLowerCase().match(/[a-z]{3,}/g) ?? [])
  return [...words].filter((w) => intent.toLowerCase().includes(w)).length
}
const top = scored.sort((a, b) => b.overlap - a.overlap).slice(0, 30)
const client = new TypeSafeClient({ apiKey: key, pathTimeoutMs: 15000 })
const router = new SkillRouterService(() => client, {})
const started = Date.now()
const best = await router.route('把这份用户调研整理成一份 PRD 文档', top.map((entry) => entry.skill) as any)
console.log(
  'capped to ' + top.length + ' candidates -> ' + best?.name + ' in ' + (Date.now() - started) + 'ms | expected /prd/i | ' +
    (best && /prd/i.test(best.name) ? 'OK' : 'WRONG')
)
process.exit(0)
