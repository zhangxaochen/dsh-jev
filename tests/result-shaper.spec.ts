import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  clusterLines,
  DROP_MARKER,
  extractText,
  lineShape,
  looksRepetitive,
  replaceText,
  ResultShaperService,
} from '../lib/result-shaper.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'
import type { CordisContext, PostToolDecision, ToolExecution } from '../lib/types.js'

/** Repetitive progress output with one informative line in the middle. */
function noisyOutput(progressLines = 200): string {
  return [
    ...Array.from({ length: progressLines }, () => 'progress: chunk ok'),
    'ERROR in src/a.ts:42 TS2345',
    ...Array.from({ length: progressLines }, () => 'progress: chunk ok'),
  ].join('\n')
}

/** Answer the classifier: keep the cluster whose sample carries the error. */
function kindMock(overrides: Record<number, { choice: string; confidence: number }> = {}) {
  return async (req: any) => {
    const answers: Record<string, unknown> = {}
    for (const [id, question] of Object.entries(req.questions ?? {})) {
      const index = Number(String(id).replace('kind_', ''))
      const embedded = String((question as any).instructions ?? '')
      const override = overrides[index]
      const choice =
        override?.choice ?? (/ERROR|WARN|not ok|AssertionError/.test(embedded) ? 'failure' : 'routine_progress')
      answers[id] = {
        type: 'choice',
        choice,
        confidence: override?.confidence ?? 0.99,
        probabilities: { [choice]: 0.99 },
      }
    }
    return answers
  }
}

function service(mock: (req: any) => Promise<Record<string, unknown>>, config: Record<string, unknown> = {}) {
  return new ResultShaperService(() => new TypeSafeClient({ mockHandler: mock }), config)
}

function harness(mock: (req: any) => Promise<Record<string, unknown>>, config: Record<string, unknown> = {}) {
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
    preStep: () => preStepHandler?.(),
    step: async (exec: ToolExecution, content: string) =>
      postHandler(exec, { content }, async () => ({ kind: 'accept', action: 'accept' })) as Promise<
        PostToolDecision & { content?: string }
      >,
  }
}

test('lineShape normalises numbers and hashes so variants share a key', () => {
  assert.equal(
    lineShape('module src/feature-12/index.ts transformed in 15ms'),
    lineShape('module src/feature-99/index.ts transformed in 3ms')
  )
  assert.notEqual(lineShape('ERROR in src/a.ts:42'), lineShape('progress: chunk ok'))
  assert.equal(lineShape('commit 4f9a2b1c8e'), 'commit #')
})

test('clusterLines collapses variants and keeps distinct lines apart', () => {
  const clusters = clusterLines(noisyOutput(200))
  assert.equal(clusters.length, 2, 'hundreds of progress lines collapse into one cluster')
  assert.equal(clusters[0].count, 400)
  assert.match(clusters[0].sample, /progress: chunk ok/)
  assert.equal(clusters[1].count, 1)
  assert.match(clusters[1].sample, /ERROR in src\/a\.ts:42/)
})

test('looksRepetitive fires on bulk, whether or not the lines repeat verbatim', () => {
  assert.equal(looksRepetitive('short output'), false)
  assert.equal(
    looksRepetitive(Array.from({ length: 20 }, (_, i) => 'varied line ' + i + ' of 20').join('\n')),
    false
  )
  assert.equal(looksRepetitive(Array.from({ length: 60 }, () => 'downloading... 100%').join('\n')), true)
  assert.equal(looksRepetitive(noisyOutput(30)), true)
  assert.equal(
    looksRepetitive(
      Array.from({ length: 130 }, (_, i) => 'line ' + i + ' with distinct words ' + 'x'.repeat(i % 5)).join('\n')
    ),
    true
  )
  assert.equal(looksRepetitive('x'.repeat(5000)), true)
})

test('shape keeps the failure cluster and drops the rest with a marker', async () => {
  const content = noisyOutput(200)
  const shaped = await service(kindMock()).shape(content, 'pwsh')

  assert.ok(shaped, 'a classified failure among bulk must shape')
  assert.ok(shaped!.text.length < content.length)
  assert.match(shaped!.text, /ERROR in src\/a\.ts:42/)
  assert.match(shaped!.text, new RegExp(DROP_MARKER.replace('%d', '\\d+')))
  assert.equal(shaped!.keptClusters, 1)
  assert.equal(shaped!.droppedClusters, 1)
  assert.equal(shaped!.droppedLines, 400)
})

test('shape declines when the model keeps nothing', async () => {
  const onlyProgress = { 1: { choice: 'routine_progress', confidence: 0.99 } }
  assert.equal(
    await service(kindMock(onlyProgress)).shape(noisyOutput(200), 'pwsh'),
    undefined,
    'pure noise must not be reshaped'
  )

  // The honest answer for pure noise is the same on every attempt, so the turn
  // stops asking instead of spending its second budget on the same non-answer.
  const shaper = service(kindMock(onlyProgress), { thresholdChars: 100 })
  assert.equal(await shaper.shape(noisyOutput(200), 'pwsh'), undefined)
  assert.equal(
    shaper.shouldConsider({ name: 'pwsh', args: {} }, noisyOutput(200)),
    false,
    'the turn is marked declined'
  )
  shaper.resetTurnBudget()
  assert.equal(
    shaper.shouldConsider({ name: 'pwsh', args: {} }, noisyOutput(200)),
    true,
    'a new turn may try again'
  )
})

test('shape keeps clusters the model could not classify, and any beyond the cap', async () => {
  // An unusable answer keeps content rather than guessing.
  assert.equal(
    await service(async () => ({})).shape(noisyOutput(200), 'pwsh'),
    undefined,
    'nothing classified means nothing dropped'
  )

  // A cluster past maxClusters keeps its lines: the cap bounds cost, it is not a
  // licence to drop content the model never saw. Here only the progress cluster
  // is classified (as progress) while the failure cluster sits past the cap, so
  // the failure survives and the progress run collapses.
  const capped = await service(kindMock(), { maxClusters: 1 }).shape(noisyOutput(200), 'pwsh')
  assert.ok(capped, 'the uncapped cluster is kept, so shaping still happens')
  assert.match(capped!.text, /ERROR in src\/a\.ts:42/)
  assert.doesNotMatch(capped!.text, /progress: chunk ok/)
})

test('shape leaves input alone when there is nothing to decide', async () => {
  const single = await service(kindMock()).shape('progress: chunk ok\nprogress: chunk ok', 'pwsh')
  assert.equal(single, undefined, 'one cluster means no distinction to make')
})

test('apply shapes eligible results only and preserves the invariants', async () => {
  let calls = 0
  const h = harness(
    async (req) => {
      calls += 1
      return kindMock()(req)
    },
    { thresholdChars: 1000 }
  )

  const exec: ToolExecution = { name: 'pwsh', args: { command: 'build' } }
  const shaped = await h.step(exec, noisyOutput(200))
  assert.ok(shaped.content, 'eligible output must be replaced')
  assert.match(shaped.content!, /dropped by TypeSafe result shaper/)

  const before = calls
  const untouched = await h.step({ name: 'read_file', args: {} }, noisyOutput(200))
  assert.equal(untouched.content, undefined)
  assert.equal(calls, before, 'ineligible tools must not trigger a decision')

  h.preStep()
  const afterReset = await h.step(exec, noisyOutput(200).replace(/ok/g, 'ok2'))
  assert.ok(afterReset.content ?? true, 'a new turn resets the budget')
})

test('apply never shapes a failed result or one already rewritten downstream', async () => {
  let postHandler: any
  const ctx: CordisContext = {
    on: (event: string, callback: any) => {
      if (event === 'tools/post-execute') postHandler = callback
      return () => {}
    },
    typesafe: new TypeSafeClient({
      mockHandler: async () => {
        throw new Error('must not be called')
      },
    }),
  }
  apply(ctx, {})

  const failed = await postHandler(
    { name: 'pwsh', args: {} },
    { content: noisyOutput(200), isError: true },
    async () => ({ kind: 'accept', action: 'accept' })
  )
  assert.equal(failed.content, undefined)

  const rewritten = await postHandler(
    { name: 'pwsh', args: {} },
    { content: noisyOutput(200) },
    async () => ({ kind: 'accept', action: 'accept', content: 'downstream text' })
  )
  assert.equal(rewritten.content, 'downstream text')
})

test('apply stays silent when the decision call fails', async () => {
  const h = harness(async () => {
    throw new Error('api down')
  })
  const decision = await h.step({ name: 'pwsh', args: {} }, noisyOutput(200))
  assert.equal(decision.content, undefined)
  assert.equal(decision.kind, 'accept')
})

test('extractText reads both the string form and the block form the service uses', () => {
  assert.equal(extractText('plain text'), 'plain text')
  assert.equal(
    extractText([{ type: 'text', text: 'a' }, { type: 'image', url: 'x' }, { type: 'text', text: 'b' }]),
    'a\nb'
  )
  assert.equal(extractText([{ type: 'image', url: 'x' }]), undefined)
  assert.equal(extractText(undefined), undefined)
  assert.equal(extractText({ type: 'text', text: 'not an array' }), undefined)
})

test('replaceText collapses text blocks in place and preserves every other block order', () => {
  assert.equal(replaceText('old', 'new'), 'new')

  const rebuilt = replaceText(
    [
      { type: 'image', url: 'first' },
      { type: 'text', text: 'old a' },
      { type: 'resource', uri: 'middle' },
      { type: 'text', text: 'old b' },
      { type: 'image', url: 'last' },
    ],
    'shaped'
  ) as Array<Record<string, unknown>>

  assert.deepEqual(
    rebuilt.map((block) => (block.type === 'text' ? block.text : block.type)),
    ['image', 'shaped', 'resource', 'image'],
    'rich blocks must keep their relative positions around the single text block'
  )

  const appended = replaceText([{ type: 'image', url: 'only' }], 'shaped') as Array<Record<string, unknown>>
  assert.deepEqual(appended.map((block) => block.type), ['image', 'text'])
})

test('shape honours minKindConfidence', async () => {
  // The knob decides how sure the classifier must be before a cluster is dropped, and
  // nothing pinned it: lowering it changed behaviour with every test still green.
  const content = noisyOutput(200)

  const unsure = await service(
    async () => ({
      kind_0: { type: 'choice', choice: 'routine_progress', confidence: 0.99, probabilities: {} },
      kind_1: { type: 'choice', choice: 'failure', confidence: 0.3, probabilities: {} },
    })
  ).shape(content, 'pwsh')
  assert.equal(unsure, undefined, 'a low-confidence failure must not license dropping the rest')

  const sure = await service(
    async () => ({
      kind_0: { type: 'choice', choice: 'routine_progress', confidence: 0.99, probabilities: {} },
      kind_1: { type: 'choice', choice: 'failure', confidence: 0.9, probabilities: {} },
    })
  ).shape(content, 'pwsh')
  assert.ok(sure, 'a confident failure keeps the cluster that carries it and drops the noise')
  assert.match(sure!.text, /ERROR in src\/a\.ts:42/)

  // Raising the bar above the answer's confidence has the same effect as the low one.
  const strict = await service(
    async () => ({
      kind_0: { type: 'choice', choice: 'routine_progress', confidence: 0.99, probabilities: {} },
      kind_1: { type: 'choice', choice: 'failure', confidence: 0.9, probabilities: {} },
    }),
    { minKindConfidence: 0.95 }
  ).shape(content, 'pwsh')
  assert.equal(strict, undefined, 'minKindConfidence governs whether a cluster is kept')
})

test('apply honours maxPerTurn and resets it for the next instruction', async () => {
  const h = harness(
    async (req: any) => {
      const answers: Record<string, unknown> = {}
      for (const [id, question] of Object.entries(req.questions ?? {})) {
        const embedded = String((question as any).instructions ?? '')
        const choice = /ERROR/.test(embedded) ? 'failure' : 'routine_progress'
        answers[id] = { type: 'choice', choice, confidence: 0.99, probabilities: {} }
      }
      return answers
    },
    { thresholdChars: 1000, maxPerTurn: 1 }
  )

  const exec: ToolExecution = { name: 'pwsh', args: { command: 'build' } }
  const first = await h.step(exec, noisyOutput(200))
  assert.ok(first.content, 'the first eligible result is shaped')

  const second = await h.step(exec, noisyOutput(200).replace(/ok/g, 'ok2'))
  assert.equal(second.content, undefined, 'the per-turn budget stops the second')

  h.preStep()
  const nextTurn = await h.step(exec, noisyOutput(200).replace(/ok/g, 'ok3'))
  assert.ok(nextTurn.content, 'a new instruction gets a fresh budget')
})
