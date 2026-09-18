import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RANK_CANDIDATES, registerJevTools } from '../lib/ask-tools.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'
import type { CordisContext } from '../lib/types.js'

function harness(mock: (req: any) => Promise<Record<string, unknown>>) {
  const registered = new Map<string, any>()
  const ctx: CordisContext = {
    on: () => () => {},
    get: (name: string) =>
      name === 'tools'
        ? {
            register: (tool: any) => {
              registered.set(tool.name, tool)
              return () => registered.delete(tool.name)
            },
          }
        : name === 'typesafe'
          ? new TypeSafeClient({ mockHandler: mock })
          : undefined,
  }
  const disposers = registerJevTools(ctx, () => new TypeSafeClient({ mockHandler: mock }))
  return { registered, disposers }
}

test('jev_ask batches typed questions and projects every answer', async () => {
  const seen: any[] = []
  const { registered } = harness(async (req) => {
    seen.push(req)
    return {
      is_risky: { type: 'noul', noul: 0.82 },
      route: { type: 'choice', choice: 'scraper', confidence: 0.91, probabilities: { scraper: 0.91, recipe: 0.09 } },
      quality: { type: 'score', score: 1.4, confidence: 0.77, probabilities: { '0': 0.1, '1': 0.5, '2': 0.4 } },
      broken: { type: 'noul' },
    }
  })

  const tool = registered.get('jev_ask')
  assert.ok(tool)

  const out = await tool.execute({
    state: 'the diff touches prod credentials',
    questions: [
      { id: 'is_risky', kind: 'noul', instructions: 'Is this risky?' },
      { id: 'route', kind: 'choice', instructions: 'Where?', criteria: { scraper: 'Scrape', recipe: 'Recipe' } },
      { id: 'quality', kind: 'score', instructions: 'How good?', criteria: ['low', 'mid', 'high'] },
      { id: 'broken', kind: 'noul', instructions: 'Anything?' },
    ],
  })

  assert.equal(seen.length, 1, 'all questions must travel in one request')
  assert.equal(Object.keys(seen[0].questions).length, 4)

  const byId = Object.fromEntries(out.answers.map((a: any) => [a.id, a]))
  assert.equal(byId.is_risky.probability, 0.82)
  assert.equal(byId.route.choice, 'scraper')
  assert.equal(byId.quality.score, 1.4)
  assert.equal(byId.broken.unknown, true, 'a missing value must stay unknown')

  const rendered = tool.output.render({}, out)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /is_risky/)
})

test('jev_ask rejects an empty question list and a malformed choice', async () => {
  const { registered } = harness(async () => ({}))
  const tool = registered.get('jev_ask')

  await assert.rejects(() => tool.execute({ state: 'x', questions: [] }), /at least one question/)
  await assert.rejects(
    () => tool.execute({ state: 'x', questions: [{ id: 'a', kind: 'choice', instructions: 'pick' }] }),
    /criteria object/
  )
})

test('jev_rank orders candidates by their scored applicability', async () => {
  const { registered } = harness(async () => ({
    rank_a: { type: 'score', score: 0.2, confidence: 0.9, probabilities: {} },
    rank_b: { type: 'score', score: 1.8, confidence: 0.8, probabilities: {} },
    rank_c: { type: 'score', score: 1.0, confidence: 0.7, probabilities: {} },
  }))

  const tool = registered.get('jev_rank')
  const out = await tool.execute({
    criterion: 'is most relevant to the current task',
    candidates: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ],
  })

  assert.deepEqual(
    out.ranked.map((entry: any) => entry.id),
    ['b', 'c', 'a']
  )
})

test('jev_rank refuses an unbounded candidate list', async () => {
  const { registered } = harness(async () => ({}))
  const tool = registered.get('jev_rank')
  const candidates = Array.from({ length: MAX_RANK_CANDIDATES + 1 }, (_, index) => ({
    id: 'c' + index,
    label: 'C' + index,
  }))

  await assert.rejects(() => tool.execute({ criterion: 'x', candidates }), /at most/)
})

test('jev_check reports holds, refuted and unknown distinctly', async () => {
  const answers = async () => ({ holds: { type: 'noul', noul: 0.9 } })
  const a = harness(answers)
  const held = await a.registered.get('jev_check').execute({ state: 'tests pass', claim: 'suite is green' })
  assert.equal(held.holds, true)
  assert.equal(held.unknown, false)

  const b = harness(async () => ({ holds: { type: 'noul', noul: 0.2 } }))
  const refuted = await b.registered.get('jev_check').execute({ state: 'tests fail', claim: 'suite is green' })
  assert.equal(refuted.holds, false)

  const c = harness(async () => ({ holds: { type: 'noul' } }))
  const undecided = await c.registered.get('jev_check').execute({ state: 'x', claim: 'y' })
  assert.equal(undecided.unknown, true)
  assert.equal(undecided.holds, false)
})

test('registerJevTools returns disposers and tolerates a host without tools', () => {
  const { registered, disposers } = harness(async () => ({}))
  assert.deepEqual([...registered.keys()].sort(), ['jev_ask', 'jev_check', 'jev_rank'])
  for (const dispose of disposers) dispose()
  assert.equal(registered.size, 0)

  const bare: CordisContext = { on: () => () => {} }
  assert.deepEqual(registerJevTools(bare, () => new TypeSafeClient({ mockHandler: async () => ({}) })), [])
})
