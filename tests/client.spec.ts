import test from 'node:test'
import { readFileSync, rmSync } from 'node:fs'
import assert from 'node:assert/strict'
import {
  TypeSafeClient,
  noul,
  choice,
  score,
  apply,
} from '../lib/typesafe-client.js'
import type { CordisContext } from '../lib/types.js'

test('Question definition helpers', () => {
  const n = noul('Is this statement true?')
  assert.equal(n.type, 'noul')
  assert.equal(n.instructions, 'Is this statement true?')

  const c = choice('Pick one category', { a: 'Option A', b: 'Option B' })
  assert.equal(c.type, 'choice')
  assert.equal(c.criteria.a, 'Option A')

  const s = score('Rate performance', ['Bad', 'Good'])
  assert.equal(s.type, 'score')
  assert.equal(s.criteria[0], 'Bad')
})

test('TypeSafeClient throws when API key is missing and no mock handler', async () => {
  const oldKey = process.env.TYPESAFE_API_KEY
  const oldNodeEnv = process.env.NODE_ENV
  delete process.env.TYPESAFE_API_KEY
  process.env.NODE_ENV = 'test'

  try {
    const client = new TypeSafeClient()
    await assert.rejects(
      async () => {
        await client.systemOne({
          state: 'test',
          questions: { q: noul('question') },
        })
      },
      /TypeSafe API key missing/
    )
  } finally {
    if (oldKey) process.env.TYPESAFE_API_KEY = oldKey
    if (oldNodeEnv !== undefined) {
      process.env.NODE_ENV = oldNodeEnv
    } else {
      delete process.env.NODE_ENV
    }
  }
})

test('TypeSafeClient executes with mockHandler', async () => {
  const client = new TypeSafeClient({
    mockHandler: async (req) => {
      assert.equal(req.state, 'sample state')
      assert.ok(req.questions.check)
      return {
        check: { type: 'noul', probability: 0.95 },
      }
    },
  })

  const res = await client.systemOne({
    state: 'sample state',
    questions: {
      check: noul('Verify sample'),
    },
  })

  assert.equal(res.check?.type, 'noul')
  if (res.check?.type === 'noul') {
    assert.equal(res.check.probability, 0.95)
  }
})

test('Cordis plugin mounting and teardown', () => {
  const fakeContext: CordisContext = {
    on: () => () => {},
  }

  const dispose = apply(fakeContext, { apiKey: 'test-key' })
  assert.ok(fakeContext.typesafe instanceof TypeSafeClient)
  assert.equal(fakeContext.typesafe.apiKey, 'test-key')

  dispose()
  assert.equal(fakeContext.typesafe, undefined)
})

test('TypeSafeClient fetches for real, caches identical payloads and reports failures', async () => {
  // Every other test here takes the mockHandler shortcut, so the fetch path, the
  // cache write and the error message had no gate at all.
  const realFetch = globalThis.fetch
  const calls: Array<{ body: string }> = []
  let behaviour: 'ok' | 'http-error' = 'ok'

  globalThis.fetch = (async (_url: string, init: any) => {
    calls.push({ body: String(init?.body ?? '') })
    if (behaviour === 'http-error') {
      return { ok: false, status: 429, text: async () => 'rate limited' }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ answers: { q1: { type: 'noul', noul: 0.77 } } }),
    }
  }) as any

  try {
    const client = new TypeSafeClient({ apiKey: 'test-key' })
    const request = () => client.systemOne({ state: { a: 1 }, questions: { q1: noul('is it true?') } })

    const first = await request()
    assert.equal((first.q1 as any).noul, 0.77)
    assert.match(calls[0].body, /is it true\?/, 'the question must be serialized into the body')

    // Identical payload within the TTL is served from memory.
    const second = await request()
    assert.equal((second.q1 as any).noul, 0.77)
    assert.equal(calls.length, 1, 'an identical payload must not round trip twice')

    // A different payload does go out.
    await client.systemOne({ state: { a: 2 }, questions: { q1: noul('is it true?') } })
    assert.equal(calls.length, 2)

    // The same key after the TTL expires goes out again.
    const expiring = new TypeSafeClient({ apiKey: 'test-key', cacheTtlMs: 1 })
    await expiring.systemOne({ state: { a: 3 }, questions: { q1: noul('ttl?') } })
    const before = calls.length
    await new Promise((resolve) => setTimeout(resolve, 5))
    await expiring.systemOne({ state: { a: 3 }, questions: { q1: noul('ttl?') } })
    assert.equal(calls.length, before + 1, 'an expired entry must be refetched')

    // A caching client hands out copies, so one caller cannot corrupt another.
    const shared = await request()
    ;(shared.q1 as any).noul = 0
    const again = await request()
    assert.equal((again.q1 as any).noul, 0.77, 'the cached answer must not be mutated through a returned object')

    behaviour = 'http-error'
    await assert.rejects(
      () => client.systemOne({ state: { a: 4 }, questions: { q1: noul('fail?') } }),
      /status 429: rate limited/,
      'the status and body belong in the error'
    )
  } finally {
    globalThis.fetch = realFetch
  }
})

test('the identical-payload cache stays bounded', async () => {
  // The cache cap (oldest entry evicted past 200) had no gate: the eviction path
  // only runs when a session asks more than 200 distinct questions.
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return { ok: true, status: 200, json: async () => ({ answers: { q: { type: 'noul', noul: 1 } } }) }
  }) as any

  try {
    const client = new TypeSafeClient({ apiKey: 'test-key' })
    for (let i = 0; i < 205; i += 1) {
      await client.systemOne({ state: { i }, questions: { q: noul('question ' + i + '?') } })
    }
    assert.equal(calls, 205, 'every distinct payload still round trips once')

    // The first payload was evicted, so asking it again goes back to the model...
    await client.systemOne({ state: { i: 0 }, questions: { q: noul('question 0?') } })
    assert.equal(calls, 206, 'the oldest entry is evicted rather than kept forever')

    // ...while a recent one is still served from the cache.
    await client.systemOne({ state: { i: 204 }, questions: { q: noul('question 204?') } })
    assert.equal(calls, 206, 'recent entries stay cached')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a call is charged for its input bytes and priced at the documented rate', async () => {
  // The dashboard's cost and byte figures come from this accounting; nothing asserted
  // it, so zeroing either number changed what the operator sees with every test green.
  const metricsPath = process.env.DSH_JEV_METRICS_PATH!
  try {
    rmSync(metricsPath, { force: true })
  } catch {}

  const client = new TypeSafeClient({
    mockHandler: async () => ({ flag: { type: 'noul', noul: 0.9 } }),
  })
  await client.systemOne({ state: 'x'.repeat(400), questions: { flag: noul('does it hold?') } })

  // The documented pricing: ~4 bytes per token, 0.042 USD per million input tokens.
  const snapshot = JSON.parse(readFileSync(metricsPath, 'utf8'))
  const calls = snapshot.systemOne
  assert.ok(calls.inputBytes > 0, 'a call must be charged for its payload')
  const expected = (calls.inputBytes / 4 / 1_000_000) * 0.042
  assert.ok(
    Math.abs(calls.estimatedCostUsd - expected) < 1e-12,
    'cost must follow the documented rate: ' + calls.estimatedCostUsd + ' vs ' + expected
  )
})
