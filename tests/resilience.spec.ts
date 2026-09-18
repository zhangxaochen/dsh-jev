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

test('Resilience: a guarded tool fails closed when the API returns 429', async () => {
  const invoke = guardHarness(failingClient('TypeSafe API request failed with status 429: Too Many Requests'))
  const { result, nextCalled } = await invoke({ name: 'bash', args: { command: 'npm test' } })

  assert.equal(result.kind, 'deny')
  assert.equal(nextCalled, false)
  assert.match(result.reason ?? '', /onError=deny-guarded/)
})

test('Resilience: a guarded tool fails closed when the API returns 500', async () => {
  const invoke = guardHarness(failingClient('TypeSafe API request failed with status 500: Internal Server Error'))
  const { result } = await invoke({ name: 'bash', args: { command: 'npm test' } })

  assert.equal(result.kind, 'deny')
})

test('Resilience: an unguarded tool still passes through on API failure', async () => {
  const invoke = guardHarness(failingClient('TypeSafe API request failed with status 429'), { guardedTools: ['bash'] })
  const { result, nextCalled } = await invoke({ name: 'fetch_web', args: { url: 'https://example.com' } })

  assert.equal(nextCalled, true)
  assert.equal(result.kind, 'allow')
})

test("Resilience: onError 'allow' preserves the legacy fail-open behaviour", async () => {
  const invoke = guardHarness(failingClient('TypeSafe API request failed with status 429'), { onError: 'allow' })
  const { result, nextCalled } = await invoke({ name: 'bash', args: { command: 'npm test' } })

  assert.equal(nextCalled, true)
  assert.equal(result.kind, 'allow')
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
