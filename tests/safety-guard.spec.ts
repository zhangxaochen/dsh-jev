import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/safety-guard.js'
import { TypeSafeClient } from '../lib/client.js'
import type {
  CordisContext,
  PreToolDecision,
  ToolExecution,
} from '../lib/types.js'

test('TypeSafeSafetyGuard blocks destructive command with deny', async () => {
  let preExecuteHandler: any

  const fakeContext: CordisContext = {
    on: (event: string, callback: any) => {
      if (event === 'tools/pre-execute') {
        preExecuteHandler = callback
      }
      return () => {}
    },
    typesafe: new TypeSafeClient({
      mockHandler: async () => ({
        is_destructive: { type: 'noul', probability: 0.98 },
        is_jailbreak: { type: 'noul', probability: 0.05 },
        risk_score: {
          type: 'score',
          score: 3,
          probabilities: { 1: 0, 2: 0.05, 3: 0.95 },
          confidence: 0.99,
        },
      }),
    }),
  }

  apply(fakeContext)

  const toolExec: ToolExecution = {
    name: 'bash',
    args: { command: 'rm -rf / --no-preserve-root' },
  }

  const decision = await preExecuteHandler(
    { action: 'allow' },
    toolExec,
    (d: PreToolDecision) => d
  )

  assert.equal(decision.action, 'deny')
  assert.match(decision.reason ?? '', /Execution blocked: Tool action deemed high risk/)
})

test('TypeSafeSafetyGuard requires approval for moderate risk command', async () => {
  let preExecuteHandler: any

  const fakeContext: CordisContext = {
    on: (event: string, callback: any) => {
      if (event === 'tools/pre-execute') {
        preExecuteHandler = callback
      }
      return () => {}
    },
    typesafe: new TypeSafeClient({
      mockHandler: async () => ({
        is_destructive: { type: 'noul', probability: 0.45 },
        is_jailbreak: { type: 'noul', probability: 0.1 },
        risk_score: {
          type: 'score',
          score: 2,
          probabilities: { 1: 0.2, 2: 0.7, 3: 0.1 },
          confidence: 0.85,
        },
      }),
    }),
  }

  apply(fakeContext, { askApprovalThreshold: 0.4 })

  const toolExec: ToolExecution = {
    name: 'run_command',
    args: { command: 'git push --force' },
  }

  const decision = await preExecuteHandler(
    { action: 'allow' },
    toolExec,
    (d: PreToolDecision) => d
  )

  assert.equal(decision.action, 'ask')
  assert.match(decision.reason ?? '', /Approval required: Tool action requires confirmation/)
})

test('TypeSafeSafetyGuard allows safe command through', async () => {
  let preExecuteHandler: any

  const fakeContext: CordisContext = {
    on: (event: string, callback: any) => {
      if (event === 'tools/pre-execute') {
        preExecuteHandler = callback
      }
      return () => {}
    },
    typesafe: new TypeSafeClient({
      mockHandler: async () => ({
        is_destructive: { type: 'noul', probability: 0.01 },
        is_jailbreak: { type: 'noul', probability: 0.01 },
        risk_score: {
          type: 'score',
          score: 1,
          probabilities: { 1: 0.99, 2: 0.01, 3: 0 },
          confidence: 0.99,
        },
      }),
    }),
  }

  apply(fakeContext)

  const toolExec: ToolExecution = {
    name: 'bash',
    args: { command: 'npm test' },
  }

  const decision = await preExecuteHandler(
    { action: 'allow' },
    toolExec,
    (d: PreToolDecision) => d
  )

  assert.equal(decision.action, 'allow')
})

test('TypeSafeSafetyGuard skips non-guarded tools', async () => {
  let preExecuteHandler: any

  const fakeContext: CordisContext = {
    on: (event: string, callback: any) => {
      if (event === 'tools/pre-execute') {
        preExecuteHandler = callback
      }
      return () => {}
    },
    typesafe: new TypeSafeClient({
      mockHandler: async () => {
        throw new Error('Should not inspect non-guarded tools')
      },
    }),
  }

  apply(fakeContext, { guardedTools: ['bash'] })

  const toolExec: ToolExecution = {
    name: 'fetch_web',
    args: { url: 'https://example.com' },
  }

  const decision = await preExecuteHandler(
    { action: 'allow' },
    toolExec,
    (d: PreToolDecision) => d
  )

  assert.equal(decision.action, 'allow')
})
