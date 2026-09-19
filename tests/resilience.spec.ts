import test from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyLoopGuard } from '../lib/loop-guard.js'
import { apply as applySafetyGuard } from '../lib/safety-guard.js'
import { ToolPrunerService } from '../lib/tool-pruner.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'
import type { CordisContext, ToolExecution, ToolDefinitionMinimal } from '../lib/types.js'

function failingClient(message: string): TypeSafeClient {
  return new TypeSafeClient({
    mockHandler: async () => {
      throw new Error(message)
    },
  })
}

function guardHarness(client: TypeSafeClient, config: Record<string, unknown> = {}) {
  let handler: any
  const ctx: CordisContext = {
    on: (evt, cb) => {
      if (evt === 'tools/pre-execute') handler = cb
      return () => {}
    },
    typesafe: client,
  }
  applySafetyGuard(ctx, config)
  return async (exec: ToolExecution) => {
    let nextCalled = false
    const result = await handler(exec, async () => {
      nextCalled = true
      return { kind: 'allow', action: 'allow' }
    })
    return { result, nextCalled }
  }
}

test('Resilience: a guarded tool fails closed when the API returns 429 and the policy says so', async () => {
  const invoke = guardHarness(failingClient('TypeSafe API request failed with status 429: Too Many Requests'), {
    onError: 'deny-guarded',
  })
  const { result, nextCalled } = await invoke({ name: 'bash', args: { command: 'npm test' } })

  assert.equal(result.kind, 'deny')
  assert.equal(nextCalled, false)
  assert.match(result.reason ?? '', /onError=deny-guarded/)
})

test('Resilience: a guarded tool fails closed when the API returns 500 and the policy says so', async () => {
  const invoke = guardHarness(failingClient('TypeSafe API request failed with status 500: Internal Server Error'), {
    onError: 'deny-guarded',
  })
  const { result } = await invoke({ name: 'bash', args: { command: 'npm test' } })

  assert.equal(result.kind, 'deny')
})

test('Resilience: an unguarded tool still passes through on API failure', async () => {
  const invoke = guardHarness(failingClient('TypeSafe API request failed with status 429'), {
    guardedTools: ['bash'],
    onError: 'deny-guarded',
  })
  const { result, nextCalled } = await invoke({ name: 'fetch_web', args: { url: 'https://example.com' } })

  assert.equal(nextCalled, true)
  assert.equal(result.kind, 'allow')
})

test('Resilience: the shipped default lets a guarded tool through when the judge is unreachable', async () => {
  // The default is allow: the judgement service is an operational dependency, and failing
  // closed turned any upstream blip into "every guarded tool is refused" - observed live,
  // where an intermittent failure blocked the operator's shell. The protections that do
  // not need the judge are unaffected, and the failure is counted.
  const invoke = guardHarness(failingClient('TypeSafe API request failed with status 429: Too Many Requests'))
  const { result, nextCalled } = await invoke({ name: 'bash', args: { command: 'npm test' } })

  assert.equal(nextCalled, true, 'the call proceeds')
  assert.equal(result.kind, 'allow')
})

test('Resilience: the deterministic envelope denies regardless of the failure policy', async () => {
  // This is what makes the default change safe to make: the unambiguous destruction is
  // refused without any judgement call, on every policy value.
  for (const onError of ['allow', 'deny-guarded', 'deny-all'] as const) {
    const invoke = guardHarness(failingClient('TypeSafe API request failed with status 429'), { onError })
    const { result, nextCalled } = await invoke({ name: 'bash', args: { command: 'rm -rf /' } })

    assert.equal(result.kind, 'deny', 'the envelope denies under onError=' + onError)
    assert.equal(nextCalled, false)
  }
})

test('Resilience: LoopGuard stays advisory and never blocks on timeout', async () => {
  let handler: any
  const ctx: CordisContext = {
    on: (evt, cb) => {
      if (evt === 'tools/post-execute') handler = cb
      return () => {}
    },
    typesafe: failingClient('The operation was aborted due to timeout'),
  }
  applyLoopGuard(ctx, { triggerThreshold: 2 })

  const exec: ToolExecution = { name: 'bash', args: { command: 'npm test' }, agent: { id: 'agent-timeout' } }
  let nextCalls = 0
  const decide = () =>
    handler(exec, { content: 'boom' }, async () => {
      nextCalls += 1
      return { kind: 'accept', action: 'accept' }
    })

  const first = await decide()
  const second = await decide()

  assert.equal(nextCalls, 2)
  assert.equal(first.additionalContexts, undefined)
  assert.equal(second.additionalContexts, undefined)
})

test('Resilience: ToolPrunerService returns the full candidate list on API failure', async () => {
  const pruner = new ToolPrunerService(() => failingClient('TypeSafe API request failed with status 500'), {
    maxTools: 2,
  })
  const candidates: ToolDefinitionMinimal[] = [
    { name: 'a', description: 'tool a' },
    { name: 'b', description: 'tool b' },
    { name: 'c', description: 'tool c' },
  ]
  const result = await pruner.pruneTools('do something', candidates)
  assert.equal(result.length, candidates.length)
})

test('a placeholder the host could not evaluate is never used as the key', () => {
  // The shipped patch says `apiKey: !!js process.env.TYPESAFE_API_KEY`. A host that
  // cannot evaluate the tag can pass the expression through as a string, and using it
  // verbatim would send the placeholder as the credential on every request.
  const placeholder = new TypeSafeClient({ apiKey: '__jsExpr:process.env.TYPESAFE_API_KEY' })
  const fromEnvironment = process.env.TYPESAFE_API_KEY
  delete process.env.TYPESAFE_API_KEY
  try {
    const withoutKey = new TypeSafeClient({ apiKey: '__jsExpr:process.env.TYPESAFE_API_KEY' })
    assert.notEqual(withoutKey.apiKey, '__jsExpr:process.env.TYPESAFE_API_KEY', 'the placeholder must never be the key')
    assert.ok(
      withoutKey.apiKey === undefined || !String(withoutKey.apiKey).startsWith('__jsExpr'),
      'a resolved key must not be the unevaluated expression'
    )
  } finally {
    if (fromEnvironment !== undefined) process.env.TYPESAFE_API_KEY = fromEnvironment
  }
})
