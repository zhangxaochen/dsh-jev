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

test('LoopGuard carries one notice under both accepted context keys', async () => {
  const h = harness(async () => STUCK_FORESEEABLE)
  const exec: ToolExecution = { name: 'bash', args: { command: 'npm test' }, agent }

  await h.step(exec, 'a')
  const decision = await h.step({ name: 'bash', args: { command: 'npm test -- -u' }, agent }, 'b')

  // The tools service merges `additionalContexts`; `contexts` exists for hosts
  // that read the older name. Each must hold the same single entry so no host
  // ever sees the notice twice.
  const additional = (decision as any).additionalContexts ?? []
  const legacy = (decision as any).contexts ?? []
  assert.equal(additional.length, 1)
  assert.equal(legacy.length, 1)
  assert.equal(additional[0].id, legacy[0].id)
})

test('LoopGuard ignores a stuck verdict that the model is not sure about', async () => {
  // Isolates the confidence gate: the dead-loop mass is high and progress is
  // absent, so only `minConfidence` can keep this quiet. The earlier
  // low-confidence case also failed the pLoop gate and therefore never exercised
  // the confidence check at all.
  const unsure = {
    has_progress: { type: 'noul', noul: 0.1 },
    stuck_severity: { type: 'score', score: 1.6, confidence: 0.3, probabilities: { '0': 0, '1': 0.2, '2': 0.8 } },
  }
  const h = harness(async () => unsure)
  const exec: ToolExecution = { name: 'bash', args: { command: 'npm test' }, agent }

  await h.step(exec, 'a')
  const decision = await h.step({ name: 'bash', args: { command: 'npm test -- -u' }, agent }, 'b')
  assert.equal(decision.additionalContexts, undefined, 'confidence 0.3 must not trigger a notice')

  // The same trajectory with a confident answer does fire, so the only difference
  // is the confidence value.
  const sure = harness(async () => ({
    has_progress: { type: 'noul', noul: 0.1 },
    stuck_severity: { type: 'score', score: 1.9, confidence: 0.9, probabilities: { '0': 0, '1': 0.05, '2': 0.95 } },
  }))
  await sure.step(exec, 'a')
  const fired = await sure.step({ name: 'bash', args: { command: 'npm test -- -u' }, agent }, 'b')
  assert.ok(fired.additionalContexts, 'the same trajectory with confidence 0.9 must fire')
})

test('the exact-repeat deferral holds only for a consecutive identical call', async () => {
  // The deferral hands exact repeats to DSH's repeat-tool-reminder, so it must not
  // widen: a near repeat is still the guard's business, or a real loop goes silent.
  const bash = (args: Record<string, unknown>): ToolExecution => ({ name: 'bash', args })
  const A = bash({ command: 'npm test' })

  async function fires(steps: Array<[ToolExecution, string]>, config: Record<string, unknown> = {}) {
    const h = harness(async () => STUCK_FORESEEABLE, config)
    let last: any
    for (const [exec, content] of steps) last = await h.step({ ...exec, agent } as ToolExecution, content)
    return Boolean(last?.additionalContexts || last?.contexts)
  }

  assert.equal(await fires([[A, 'same'], [A, 'same']]), false, 'an exact repeat is deferred, not judged')
  assert.equal(await fires([[A, 'first'], [A, 'second']]), true, 'the same call with new output is judged')
  assert.equal(
    await fires([[A, 'same'], [bash({ command: 'npm test -- -u' }), 'same']]),
    true,
    'a different argument list is judged'
  )
  assert.equal(
    await fires([[A, 'same'], [{ name: 'pwsh', args: { command: 'npm test' } }, 'same']]),
    true,
    'a different tool is judged'
  )
  assert.equal(
    await fires([[bash({ command: 'npm  test' }), 'same'], [A, 'same']]),
    true,
    'a whitespace-only argument change is a different call'
  )
  assert.equal(
    await fires([[A, 'same'], [A, 'same']], { deferExactRepeats: false }),
    true,
    'disabling the deferral puts exact repeats back under the semantic verdict'
  )

  // The canonical argument key ignores key order, so the same call written two ways
  // is still recognised as the repeat it is.
  assert.equal(
    await fires([
      [bash({ env: 'x', command: 'npm test' }), 'same'],
      [bash({ command: 'npm test', env: 'x' }), 'same'],
    ]),
    false,
    'argument key order does not make a new call'
  )
})
