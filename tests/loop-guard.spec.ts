import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/loop-guard.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'
import type { CordisContext, PostToolDecision, ToolExecution } from '../lib/types.js'

const STUCK_FORESEEABLE = {
  has_progress: { type: 'noul', noul: 0.11 },
  stuck_severity: { type: 'score', score: 1.85, confidence: 0.78, probabilities: { '0': 0, '1': 0.14, '2': 0.86 } },
}

const HEALTHY = {
  has_progress: { type: 'noul', noul: 0.62 },
  stuck_severity: { type: 'score', score: 0.06, confidence: 0.92, probabilities: { '0': 0.95, '1': 0.05, '2': 0 } },
}

const MARGINAL_LOW_CONFIDENCE = {
  has_progress: { type: 'noul', noul: 0.2 },
  stuck_severity: { type: 'score', score: 1.4, confidence: 0.28, probabilities: { '0': 0, '1': 0.6, '2': 0.4 } },
}

function harness(mock: () => Promise<Record<string, unknown>>, config: Record<string, unknown> = {}) {
  let postHandler: any
  let preStepHandler: any
  const ctx: CordisContext = {
    on: (event: string, callback: any) => {
      if (event === 'tools/post-execute') postHandler = callback
      if (event === 'agent/pre-step') preStepHandler = callback
      return () => {}
    },
    typesafe: new TypeSafeClient({ mockHandler: mock }),
  }
  apply(ctx, config)
  return {
    ctx,
    // agent/pre-step is a waterfall: the handler must hand the decision back.
    preStep: (agent: unknown) => preStepHandler?.({ agent }, async () => ({ kind: 'enter', messages: ['kept'] })),
    // Mirrors the DSH waterfall contract: (exec, result, next) where next takes no arguments.
    step: async (exec: ToolExecution, content = 'same output') =>
      postHandler(exec, { content }, async () => ({ kind: 'accept', action: 'accept' })) as Promise<
        PostToolDecision & { additionalContexts?: any[] }
      >,
  }
}

const agent = { id: 'agent-under-test' }

test('LoopGuard reports a genuinely stuck trajectory', async () => {
  const h = harness(async () => STUCK_FORESEEABLE)
  const exec: ToolExecution = { name: 'bash', args: { command: 'npm test' }, agent }

  const first = await h.step(exec, 'error: cannot find module foo')
  assert.equal(first.additionalContexts, undefined, 'nothing to say on the first step')

  const second = await h.step(exec, 'error: cannot find module foo 2nd attempt')
  assert.ok(second.additionalContexts, 'second no-progress step must be evaluated')
  const text = second.additionalContexts![0]?.content[0]?.text ?? ''
  assert.match(text, /Potential loop or stagnation detected/)
  assert.match(text, /dead-loop probability 86%/)
  assert.match(text, /severity 1\.85\/2/)
  assert.match(text, /confidence 78%/)
})

test('LoopGuard stays silent on healthy exploration', async () => {
  const h = harness(async () => HEALTHY)
  const exec: ToolExecution = { name: 'read_file', args: { path: 'a.ts' }, agent }

  await h.step(exec, 'code 1')
  const second = await h.step(exec, { name: 'read_file', args: { path: 'b.ts' }, agent }, 'code 2')
  assert.equal(second.additionalContexts, undefined)
})

test('LoopGuard ignores a low-confidence or ambiguous verdict', async () => {
  const h = harness(async () => MARGINAL_LOW_CONFIDENCE)
  const exec: ToolExecution = { name: 'pwsh', args: { command: 'echo x' }, agent }

  await h.step(exec, 'out 1')
  const second = await h.step({ name: 'pwsh', args: { command: 'echo y' }, agent }, 'out 2')
  assert.equal(second.additionalContexts, undefined, 'confidence 0.28 must not trigger a notice')
})

test('LoopGuard ignores an unusable answer instead of guessing', async () => {
  const h = harness(async () => ({}))
  const exec: ToolExecution = { name: 'bash', args: { command: 'npm test' }, agent }

  await h.step(exec, 'a')
  const second = await h.step({ name: 'bash', args: { command: 'npm test -- --watch' }, agent }, 'b')
  assert.equal(second.additionalContexts, undefined)
})

test('LoopGuard defers exact repeats to repeat-tool-reminder', async () => {
  const h = harness(async () => STUCK_FORESEEABLE)
  const exec: ToolExecution = { name: 'bash', args: { command: 'npm test' }, agent }

  await h.step(exec, 'identical output')
  const repeated = await h.step({ name: 'bash', args: { command: 'npm test' }, agent }, 'identical output')
  assert.equal(repeated.additionalContexts, undefined)

  const strict = harness(async () => STUCK_FORESEEABLE, { deferExactRepeats: false })
  await strict.step(exec, 'identical output')
  const judged = await strict.step({ name: 'bash', args: { command: 'npm test' }, agent }, 'identical output')
  assert.ok(judged.additionalContexts, 'with the deferral disabled the semantic verdict applies')
})

test('LoopGuard passes the agent/pre-step decision through untouched', async () => {
  const h = harness(async () => HEALTHY)
  const decision = await h.preStep(agent)

  assert.equal(
    decision?.kind,
    'enter',
    'a waterfall listener that does not delegate leaves the agent loop without a decision'
  )
  assert.deepEqual(decision?.messages, ['kept'])
})

test('LoopGuard honours the cooldown after a notice', async () => {
  const h = harness(async () => STUCK_FORESEEABLE, { cooldownSteps: 2 })
  const exec: ToolExecution = { name: 'bash', args: { command: 'npm test' }, agent }

  await h.step(exec, 'a')
  const fired = await h.step({ name: 'bash', args: { command: 'npm test -- -u' }, agent }, 'b')
  assert.ok(fired.additionalContexts)

  const cooled = await h.step({ name: 'bash', args: { command: 'npm test -- -x' }, agent }, 'c')
  assert.equal(cooled.additionalContexts, undefined, 'cooldown must suppress repeated notices')
})

test('LoopGuard resets its chain on a new user instruction', async () => {
  const h = harness(async () => STUCK_FORESEEABLE)
  const exec: ToolExecution = { name: 'bash', args: { command: 'npm test' }, agent }

  await h.step(exec, 'a')
  h.preStep(agent)

  const afterReset = await h.step({ name: 'bash', args: { command: 'npm test' }, agent }, 'b')
  assert.equal(afterReset.additionalContexts, undefined, 'a fresh instruction is never a loop')
})

test('LoopGuard keeps its per-agent history bounded', async () => {
  const depths: number[] = []
  const h = harness(
    async (req: any) => {
      depths.push(Number(req?.state?.historyDepth ?? 0))
      return HEALTHY
    },
    { maxHistory: 4, triggerThreshold: 2 }
  )

  for (let i = 0; i < 30; i += 1) {
    await h.step({ name: 'read_file', args: { path: 'f' + i + '.ts' }, agent }, 'output ' + i)
  }

  assert.ok(depths.length > 0, 'the semantic layer must have been consulted')
  assert.ok(
    depths.every((depth) => depth <= 4),
    'history window must never exceed maxHistory, saw ' + JSON.stringify(depths)
  )
})

test('LoopGuard honours the exclude list and ignores agent-less calls', async () => {
  let modelCalls = 0
  const h = harness(async () => {
    modelCalls += 1
    return STUCK_FORESEEABLE
  }, { exclude: ['status_ping'] })

  await h.step({ name: 'status_ping', args: {}, agent }, 'a')
  await h.step({ name: 'status_ping', args: {}, agent }, 'b')
  assert.equal(modelCalls, 0)

  await h.step({ name: 'bash', args: { command: 'npm test' } }, 'c')
  await h.step({ name: 'bash', args: { command: 'npm test' } }, 'd')
  assert.equal(modelCalls, 0, 'calls without an agent have nobody to remind')
})
