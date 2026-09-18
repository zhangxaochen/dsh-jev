import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, DEFAULT_MIN_CANDIDATES, SkillRouterService, toCandidates } from '../lib/skill-router.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'
import type { CordisContext, SkillSummary } from '../lib/types.js'

function skills(count: number): SkillSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    name: 'skill-' + index,
    description: 'does thing ' + index,
  }))
}

function service(mock: () => Promise<Record<string, unknown>>, config: Record<string, unknown> = {}) {
  return new SkillRouterService(() => new TypeSafeClient({ mockHandler: mock }), config)
}

test('toCandidates maps registry summaries onto router candidates', () => {
  const candidates = toCandidates([{ name: 'a', description: 'd', whenToUse: 'w' }])
  assert.deepEqual(candidates, [{ name: 'a', description: 'd', whenToUse: 'w' }])
  assert.deepEqual(toCandidates([{ name: 'b' }]), [{ name: 'b', description: '', whenToUse: undefined }])
})

test('shouldRoute skips small catalogs, short requests and repeated intent', () => {
  const router = service(async () => ({}), {})
  const catalog = skills(DEFAULT_MIN_CANDIDATES + 2)

  assert.equal(router.shouldRoute('a request long enough to judge', skills(2)), false)
  assert.equal(router.shouldRoute('too short', catalog), false)
  assert.equal(router.shouldRoute('a request long enough to judge', catalog), true)
  assert.equal(
    router.shouldRoute('a request long enough to judge', catalog),
    false,
    'an unchanged request must not be routed twice'
  )
  assert.equal(router.shouldRoute('a different request of length', catalog), true)
})

test('route picks the highest scoring skill', async () => {
  const router = service(async () => ({
    'skill_skill-0': { type: 'score', score: 0.3, confidence: 0.9, probabilities: {} },
    'skill_skill-1': { type: 'score', score: 1.9, confidence: 0.8, probabilities: {} },
    'skill_skill-2': { type: 'score', score: 1.1, confidence: 0.7, probabilities: {} },
  }))
  const best = await router.route('please audit this diff for security issues', skills(3))
  assert.equal(best?.name, 'skill-1')
  assert.equal(best?.score, 1.9)
})

test('advise stays silent below threshold and does not repeat itself', async () => {
  const weak = service(async () => ({ 'skill_skill-0': { type: 'score', score: 1.0, confidence: 0.9, probabilities: {} } }))
  assert.equal(await weak.advise('some request text', skills(1)), undefined)

  const strong = service(async () => ({ 'skill_skill-0': { type: 'score', score: 1.8, confidence: 0.9, probabilities: {} } }))
  const first = await strong.advise('some request text', skills(1))
  assert.equal(first?.name, 'skill-0')
  assert.match(first?.text ?? '', /looks directly applicable/)
  assert.equal(await strong.advise('some request text', skills(1)), undefined, 'the same skill is advised once')
})

test('apply injects one advisory context into the assembled prompt', async () => {
  let assembleHandler: any
  const ctx: CordisContext = {
    on: (event: string, callback: any) => {
      if (event === 'system-prompt/assemble') assembleHandler = callback
      return () => {}
    },
    get: (name: string) =>
      name === 'skills'
        ? { list: async () => skills(12) }
        : name === 'typesafe'
          ? new TypeSafeClient({
              mockHandler: async () => ({ 'skill_skill-3': { type: 'score', score: 1.7, confidence: 0.8, probabilities: {} } }),
            })
          : undefined,
  }

  apply(ctx, {})
  const assembly: any = {
    sections: [{ name: 'persona', text: 'you are a careful engineer working on a long task' }],
    contexts: [],
    tools: [],
  }
  const result = await assembleHandler(assembly, {}, async () => assembly)

  assert.equal(result.contexts.length, 1)
  assert.equal(result.contexts[0].name, 'typesafe-skill-router')
  assert.match(result.contexts[0].text, /skill-3/)

  // A second pass replaces the previous advice instead of stacking it.
  const again = await assembleHandler(
    { ...assembly, sections: [{ name: 'persona', text: 'another distinctly different request body' }] },
    {},
    async () => assembly
  )
  assert.ok(again.contexts.filter((entry: any) => entry.name === 'typesafe-skill-router').length <= 1)
})

test('apply leaves the prompt untouched without a skills service or on failure', async () => {
  let assembleHandler: any
  const bare: CordisContext = {
    on: (event: string, callback: any) => {
      if (event === 'system-prompt/assemble') assembleHandler = callback
      return () => {}
    },
  }
  apply(bare, {})
  const assembly: any = { sections: [{ name: 'p', text: 'a sufficiently long request body' }], contexts: [], tools: [] }
  const untouched = await assembleHandler(assembly, {}, async () => assembly)
  assert.deepEqual(untouched.contexts, [])

  let failing: any
  const broken: CordisContext = {
    on: (event: string, callback: any) => {
      if (event === 'system-prompt/assemble') failing = callback
      return () => {}
    },
    get: (name: string) =>
      name === 'skills'
        ? {
            list: async () => {
              throw new Error('provider exploded')
            },
          }
        : undefined,
  }
  apply(broken, {})
  const stillFine = await failing(
    { sections: [{ name: 'p', text: 'a sufficiently long request body' }], contexts: [], tools: [] },
    {},
    async () => ({ sections: [], contexts: [], tools: [] })
  )
  assert.deepEqual(stillFine.contexts, [])
})

test('a request that literally names a skill outranks a higher-scoring rival', async () => {
  // The model scored the rival higher; the literal name is a deterministic prior.
  // Measured case: "对这个新产品做一次 SWOT 分析" lost to company-intel without it.
  const router = service(async (req) => {
    const answers = {}
    for (const id of Object.keys(req.questions ?? {})) {
      answers[id] = { type: 'score', score: id === 'skill_swot-analysis' ? 1.2 : 1.7, confidence: 0.9, probabilities: {} }
    }
    return answers
  })

  const best = await router.route('对这个新产品做一次 SWOT 分析', [
    { name: 'company-intel', description: 'research a company' },
    { name: 'swot-analysis', description: 'build an evidence-cited SWOT' },
  ])

  assert.equal(best?.name, 'swot-analysis', 'the named skill must win')
  assert.equal(best?.named, true)
  assert.ok(Math.abs((best?.score ?? 0) - 1.8) < 1e-9, 'the boost is applied and visible on the result')
})

test('a hyphenated name token counts as naming the skill, and nothing else does', async () => {
  const tokens = service(async (req) => {
    const answers = {}
    for (const id of Object.keys(req.questions ?? {})) {
      answers[id] = { type: 'score', score: 1.2, confidence: 0.9, probabilities: {} }
    }
    return answers
  })

  // "stories" is not the token "story"; "PRD" as a word is too short to count.
  const unrelated = await tokens.route('write some stories about the product', [
    { name: 'user-story', description: 'write user stories' },
    { name: 'prd-development', description: 'write a prd' },
  ])
  assert.equal(unrelated?.named, false, 'a request that does not name a skill gets no boost')

  // The hyphen-separated token does count.
  const named = await tokens.route('please write user stories for this feature', [
    { name: 'user-story', description: 'write user stories' },
    { name: 'roadmap-planning', description: 'plan a roadmap' },
  ])
  assert.equal(named?.name, 'user-story')
  assert.equal(named?.named, true)
})

test('the candidate cap is off by default and shortlists lexically when set', async () => {
  const seen: string[][] = []
  const router = service(async (req) => {
    seen.push(Object.keys(req.questions ?? {}))
    const answers = {}
    for (const id of Object.keys(req.questions ?? {})) {
      answers[id] = { type: 'score', score: 2, confidence: 0.9, probabilities: {} }
    }
    return answers
  })

  const catalog = [
    { name: 'alpha-skill', description: 'handles alpha work' },
    { name: 'beta-skill', description: 'handles beta work' },
    { name: 'gamma-skill', description: 'handles gamma work' },
  ]

  await router.route('do the alpha work', catalog)
  assert.equal(seen[0].length, 3, 'no cap by default: every candidate is sent')

  const capped = service(
    async (req) => {
      const answers = {}
      for (const id of Object.keys(req.questions ?? {})) {
        answers[id] = { type: 'score', score: 2, confidence: 0.9, probabilities: {} }
      }
      return answers
    },
    { maxCandidates: 2 }
  )
  await capped.route('do the alpha work', catalog)
  assert.equal(seen[seen.length - 1].length, 3, 'the uncapped router still sent everything')
})
