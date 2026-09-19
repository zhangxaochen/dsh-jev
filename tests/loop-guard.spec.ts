import test from 'node:test'
import { readFileSync, rmSync } from 'node:fs'
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
  // triggerThreshold 1 keeps the streak gate out of the way: with the default 2 the
  // step after a notice would be silent because the streak was reset, so the test
  // could not tell whether the cooldown worked at all.
  const h = harness(async () => STUCK_FORESEEABLE, { triggerThreshold: 1, cooldownSteps: 2 })
  const exec: ToolExecution = { name: 'bash', args: { command: 'npm test' }, agent }

  const first = await h.step(exec, 'a')
  assert.ok(first.additionalContexts, 'the first stuck step fires')

  const cooled = await h.step({ name: 'bash', args: { command: 'npm test -- -u' }, agent }, 'b')
  assert.equal(cooled.additionalContexts, undefined, 'the cooldown must suppress the next notice')

  const stillCooled = await h.step({ name: 'bash', args: { command: 'npm test -- -x' }, agent }, 'c')
  assert.equal(stillCooled.additionalContexts, undefined, 'two cooldown steps means two silent steps')

  const resumed = await h.step({ name: 'bash', args: { command: 'npm test -- -y' }, agent }, 'd')
  assert.ok(resumed.additionalContexts, 'and it fires again once the cooldown expires')
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

test('LoopGuard passes its configured thresholds into the verdict', async () => {
  // The pure rule is covered directly; this pins the wiring, so raising a threshold in
  // config actually reaches the decision instead of being replaced by the default. The
  // default triggerThreshold of 2 means the first step only fills the streak.
  const answers = async () => STUCK_FORESEEABLE // pLoop 0.86, confidence 0.78
  const first = { name: 'bash', args: { command: 'npm test' }, agent }
  const second = { name: 'bash', args: { command: 'npm test -- -u' }, agent }

  const byDefault = harness(answers)
  await byDefault.step(first, 'a')
  const fired = await byDefault.step(second, 'b')
  assert.ok(fired.additionalContexts, 'the default thresholds fire on this answer')

  const highLoop = harness(answers, { pLoopThreshold: 0.95 })
  await highLoop.step(first, 'a')
  const notFired = await highLoop.step(second, 'b')
  assert.equal(notFired.additionalContexts, undefined, 'pLoopThreshold must gate the verdict')

  const highConfidence = harness(answers, { minConfidence: 0.9 })
  await highConfidence.step(first, 'a')
  const unconfident = await highConfidence.step(second, 'b')
  assert.equal(unconfident.additionalContexts, undefined, 'minConfidence must gate the verdict')
})

test('the advisory evaluation uses the short path timeout', async () => {
  // The advisory path has its own budget (800ms by default) so a slow suggestion can
  // never hold up the tool result; nothing pinned which timeout the call actually used.
  let seen: any
  let handler: any
  const client = new TypeSafeClient({ mockHandler: async () => STUCK_FORESEEABLE })
  Object.assign(client as any, { timeoutMs: 2000, pathTimeoutMs: 111 })
  Object.defineProperty(client, 'systemOne', {
    value: async (req: any, options: any) => {
      seen = options
      return STUCK_FORESEEABLE
    },
  })
  const ctx: CordisContext = {
    on: (event: string, callback: any) => {
      if (event === 'tools/post-execute') handler = callback
      return () => {}
    },
    typesafe: client,
  }
  apply(ctx, { triggerThreshold: 1 })

  await handler(
    { name: 'bash', args: { command: 'npm test' }, agent },
    { content: 'same output' },
    async () => ({ kind: 'accept' })
  )
  assert.equal(seen?.timeoutMs, 111, 'the advisory call must use pathTimeoutMs, not the full budget')
})

test('a fired decision is recorded under the module threshold reviews group by', async () => {
  // The decision log is grouped by module and action when thresholds are reviewed, and
  // only the log's own fixtures ever set that field - the guard's record was untested, so
  // an empty module would have quietly corrupted the review data.
  const path = process.env.DSH_JEV_DECISIONS_PATH!
  rmSync(path, { force: true })

  const h = harness(async () => STUCK_FORESEEABLE, { triggerThreshold: 1 })
  const exec: ToolExecution = { name: 'bash', args: { command: 'npm test' }, agent }
  await h.step(exec, 'a')

  const records = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const recorded = records.find((entry) => entry.action === 'warn' || entry.action === 'interrupt')
  assert.ok(recorded, 'a fired decision is logged')
  assert.equal(recorded.module, 'loop-guard', 'the record must name the module')
  assert.ok(typeof recorded.probability === 'number', 'and carry the probability the review reads')
  assert.ok(recorded.latencyMs >= 0, 'and the latency')

  // The unusable-answer branch logs its own record, with its own module field.
  const unusable = harness(async () => ({}), { triggerThreshold: 1 })
  await unusable.step({ name: 'bash', args: { command: 'npm test -- -u' }, agent }, 'b')
  const all = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const uncertain = all.find((entry) => entry.action === 'unknown')
  assert.ok(uncertain, 'an unusable answer is recorded as unknown')
  assert.equal(uncertain.module, 'loop-guard', 'the uncertain branch must name the module too')
})
