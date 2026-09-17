import test from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyLoopGuard } from '../lib/loop-guard.js'
import { apply as applySafetyGuard } from '../lib/safety-guard.js'
import { ToolPrunerService } from '../lib/tool-pruner.js'
import { TypeSafeClient } from '../lib/client.js'
import type { CordisContext, ToolExecution, ToolDefinitionMinimal } from '../lib/types.js'

test('Resilience: SafetyGuard fails open to allow on API 429 Too Many Requests', async () => {
  let handler: any
  const fakeContext: CordisContext = {
    on: (evt, cb) => {
      if (evt === 'tools/pre-execute') handler = cb
      return () => {}
    },
    typesafe: new TypeSafeClient({
      mockHandler: async () => {
        throw new Error('TypeSafe API request failed with status 429: Too Many Requests')
      },
    }),
  }

  applySafetyGuard(fakeContext)
  assert.ok(handler)

  const toolExec: ToolExecution = {
    name: 'bash',
    args: { command: 'npm test' },
  }

  let nextCalled = false
  const result = await handler(toolExec, async () => {
    nextCalled = true
    return { kind: 'allow', action: 'allow' }
  })

  assert.equal(nextCalled, true)
  assert.equal(result.kind, 'allow')
})

test('Resilience: SafetyGuard fails open to allow on API 500 Internal Server Error', async () => {
  let handler: any
  const fakeContext: CordisContext = {
    on: (evt, cb) => {
      if (evt === 'tools/pre-execute') handler = cb
      return () => {}
    },
    typesafe: new TypeSafeClient({
      mockHandler: async () => {
        throw new Error('TypeSafe API request failed with status 500: Server Error')
      },
    }),
  }

  applySafetyGuard(fakeContext)
  const toolExec: ToolExecution = {
    name: 'run_command',
    args: { command: 'node script.js' },
  }

  let nextCalled = false
  const result = await handler(toolExec, async () => {
    nextCalled = true
    return { kind: 'allow' }
  })

  assert.equal(nextCalled, true)
  assert.equal(result.kind, 'allow')
})

test('Resilience: LoopGuard fails open on timeout without blocking agent execution', async () => {
  let handler: any
  const fakeContext: CordisContext = {
    on: (evt, cb) => {
      if (evt === 'tools/post-execute') handler = cb
      return () => {}
    },
    typesafe: new TypeSafeClient({
      mockHandler: async () => {
        throw new Error('The operation was aborted due to timeout')
      },
    }),
  }

  applyLoopGuard(fakeContext, { triggerThreshold: 1 })
  const toolExec: ToolExecution = {
    name: 'edit',
    args: { file: 'test.js' },
  }

  let nextCalled = false
  const result = await handler(
    toolExec,
    { content: 'ok' },
    async () => {
      nextCalled = true
      return { kind: 'accept', action: 'accept' }
    }
  )

  assert.equal(nextCalled, true)
  assert.equal(result.kind, 'accept')
  assert.equal(result.additionalContexts, undefined)
})

test('Resilience: ToolPrunerService returns full candidate list on API failure', async () => {
  const client = new TypeSafeClient({
    mockHandler: async () => {
      throw new Error('Network partition: ECONNRESET')
    },
  })

  const pruner = new ToolPrunerService(() => client, {
    maxTools: 2,
    alwaysRetain: [],
  })

  const candidates: ToolDefinitionMinimal[] = [
    { name: 'db_query', description: 'Query SQL' },
    { name: 's3_upload', description: 'Upload S3' },
    { name: 'send_email', description: 'Send SMTP' },
  ]

  const result = await pruner.pruneTools('query users table', candidates)
  assert.equal(result.length, 3)
  assert.deepEqual(result, candidates)
})
