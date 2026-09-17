import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TypeSafeClient,
  noul,
  choice,
  score,
  apply,
} from '../lib/client.js'
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
  delete process.env.TYPESAFE_API_KEY

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
