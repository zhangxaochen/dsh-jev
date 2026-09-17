import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/loop-guard.js'
import { TypeSafeClient } from '../lib/client.js'
import type {
  CordisContext,
  PostToolDecision,
  ToolExecution,
} from '../lib/types.js'

test('TypeSafeLoopGuard injects advisory notice when stagnation detected', async () => {
  let postExecuteHandler: any

  const fakeContext: CordisContext = {
    on: (event: string, callback: any) => {
      if (event === 'tools/post-execute') {
        postExecuteHandler = callback
      }
      return () => {}
    },
    typesafe: new TypeSafeClient({
      mockHandler: async () => ({
        has_progress: { type: 'noul', probability: 0.1 },
        stuck_severity: {
          type: 'score',
          score: 3,
          probabilities: { 1: 0.05, 2: 0.15, 3: 0.8 },
          confidence: 0.95,
        },
      }),
    }),
  }

  // Setup loop guard with triggerThreshold 2
  apply(fakeContext, {
    triggerThreshold: 2,
    noProgressThreshold: 0.3,
    stuckSeverityThreshold: 2,
  })

  assert.ok(postExecuteHandler, 'Handler should be registered')

  const toolExec: ToolExecution = {
    name: 'bash',
    args: { command: 'cat missing.txt' },
    agent: { id: 'agent-1' },
  }

  // First execution - below triggerThreshold (1 < 2)
  const d1 = await postExecuteHandler(
    { action: 'accept', content: 'file not found' },
    toolExec,
    (d: PostToolDecision) => d
  )
  assert.equal(d1.additionalContexts, undefined)

  // Second execution - reaches triggerThreshold 2, triggers TypeSafe evaluation
  const d2 = await postExecuteHandler(
    { action: 'accept', content: 'file not found again' },
    toolExec,
    (d: PostToolDecision) => d
  )

  assert.ok(d2.additionalContexts)
  assert.equal(d2.additionalContexts.length, 1)
  assert.equal(d2.additionalContexts[0]?.role, 'user')
  assert.equal(d2.additionalContexts[0]?.source.plugin, 'typesafe-loop-guard')
  assert.match(
    d2.additionalContexts[0]?.content[0]?.text ?? '',
    /Potential loop or stagnation detected/
  )
})

test('TypeSafeLoopGuard does not intervene when progress is healthy', async () => {
  let postExecuteHandler: any

  const fakeContext: CordisContext = {
    on: (event: string, callback: any) => {
      if (event === 'tools/post-execute') {
        postExecuteHandler = callback
      }
      return () => {}
    },
    typesafe: new TypeSafeClient({
      mockHandler: async () => ({
        has_progress: { type: 'noul', probability: 0.9 },
        stuck_severity: {
          type: 'score',
          score: 1,
          probabilities: { 1: 0.9, 2: 0.1, 3: 0.0 },
          confidence: 0.98,
        },
      }),
    }),
  }

  apply(fakeContext, { triggerThreshold: 2 })

  const toolExec: ToolExecution = {
    name: 'read_file',
    args: { path: 'index.ts' },
    agent: { id: 'agent-2' },
  }

  await postExecuteHandler({ action: 'accept', content: 'code 1' }, toolExec, (d: PostToolDecision) => d)
  const d2 = await postExecuteHandler({ action: 'accept', content: 'code 2' }, toolExec, (d: PostToolDecision) => d)

  assert.equal(d2.additionalContexts, undefined)
})

test('TypeSafeLoopGuard honors exclude list', async () => {
  let postExecuteHandler: any

  const fakeContext: CordisContext = {
    on: (event: string, callback: any) => {
      if (event === 'tools/post-execute') {
        postExecuteHandler = callback
      }
      return () => {}
    },
    typesafe: new TypeSafeClient({
      mockHandler: async () => {
        throw new Error('Should not be called for excluded tool')
      },
    }),
  }

  apply(fakeContext, {
    triggerThreshold: 1,
    exclude: ['status_ping'],
  })

  const toolExec: ToolExecution = {
    name: 'status_ping',
    args: {},
  }

  const d = await postExecuteHandler({ action: 'accept' }, toolExec, (res: PostToolDecision) => res)
  assert.equal(d.additionalContexts, undefined)
})
