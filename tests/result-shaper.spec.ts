import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  DROP_MARKER,
  extractText,
  looksRepetitive,
  replaceText,
  ResultShaperService,
  segmentText,
} from '../lib/result-shaper.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'
import type { CordisContext, PostToolDecision, ToolExecution } from '../lib/types.js'

function repetitiveOutput(blocks: number, linesPerBlock = 40): string {
  const lines: string[] = []
  for (let block = 0; block < blocks; block += 1) {
    for (let line = 0; line < linesPerBlock; line += 1) {
      lines.push(block === 1 ? 'ERROR at src/a.ts:' + line + ' unexpected token' : 'progress: chunk ' + line + ' ok')
    }
  }
  return lines.join('\n')
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

test('segmentText groups lines and honours the segment cap', () => {
  const text = Array.from({ length: 100 }, (_, index) => 'line ' + index).join('\n')
  assert.equal(segmentText(text, 40, 24).length, 3)
  const capped = segmentText(Array.from({ length: 2000 }, (_, i) => 'l' + i).join('\n'), 10, 24)
  assert.ok(capped.length <= 24, 'segments must never exceed the cap, got ' + capped.length)
  assert.match(capped[capped.length - 1] ?? '', /^l1990/m, 'the tail must survive coalescing')
})

test('looksRepetitive fires on bulk, whether or not the lines repeat verbatim', () => {
  // Below every threshold.
  assert.equal(looksRepetitive('short output'), false)
  assert.equal(looksRepetitive(Array.from({ length: 20 }, (_, i) => 'varied line ' + i + ' of 20').join('\n')), false)

  // Verbatim repetition.
  assert.equal(looksRepetitive(Array.from({ length: 60 }, () => 'downloading... 100%').join('\n')), true)
  // Structurally identical lines that differ only in numbers or hashes: the shape
  // of a build log, a numbered listing or a dependency tree listing.
  assert.equal(looksRepetitive(Array.from({ length: 60 }, (_, i) => 'unique line ' + i).join('\n')), true)
  // Bulk by volume even when every line is genuinely different.
  assert.equal(
    looksRepetitive(Array.from({ length: 130 }, (_, i) => 'line ' + i + ' with distinct words ' + 'x'.repeat(i % 5)).join('\n')),
    true
  )
  // A single enormous line (minified bundle, base64 blob).
  assert.equal(looksRepetitive('x'.repeat(5000)), true)
})

test('shape declines when the model does not separate the blocks', async () => {
  // Measured behaviour on build-log output: every block near-identical, the one
  // carrying the error included. Dropping on that basis would be arbitrary.
  const flat = new ResultShaperService(
    () =>
      new TypeSafeClient({
        mockHandler: async () => ({
          keep_0: { type: 'noul', noul: 0.35 },
          keep_1: { type: 'noul', noul: 0.36 },
          keep_2: { type: 'noul', noul: 0.34 },
        }),
      }),
    {}
  )
  assert.equal(await flat.shape(repetitiveOutput(3), 'pwsh'), undefined, 'a flat distribution must decline')

  // A separated distribution still shapes.
  const separated = new ResultShaperService(
    () =>
      new TypeSafeClient({
        mockHandler: async () => ({
          keep_0: { type: 'noul', noul: 0.02 },
          keep_1: { type: 'noul', noul: 0.95 },
          keep_2: { type: 'noul', noul: 0.03 },
        }),
      }),
    {}
  )
  const shaped = await separated.shape(repetitiveOutput(3), 'pwsh')
  assert.ok(shaped, 'a separated distribution must shape')
  assert.ok(shaped!.text.length < repetitiveOutput(3).length)
})
test('shape keeps informative blocks and drops repetitive ones', async () => {
  const service = new ResultShaperService(
    () => new TypeSafeClient({ mockHandler: async () => ({ keep_1: { type: 'noul', noul: 0.9 }, keep_0: { type: 'noul', noul: 0.05 }, keep_2: { type: 'noul', noul: 0.04 } }) }),
    {}
  )
  const content = repetitiveOutput(3)
  const shaped = await service.shape(content, 'pwsh')

  assert.ok(shaped, 'a clearly repetitive output must be shaped')
  assert.ok(shaped!.text.length < content.length)
  assert.match(shaped!.text, /ERROR at src\/a\.ts:39/)
  assert.match(shaped!.text, new RegExp(DROP_MARKER.replace('%d', '\\d+')))
  assert.equal(shaped!.keptSegments, 1)
  assert.equal(shaped!.droppedSegments, 2)
})

test('shape keeps everything when the answers are unusable or all-keep', async () => {
  const unknown = new ResultShaperService(() => new TypeSafeClient({ mockHandler: async () => ({}) }), {})
  assert.equal(await unknown.shape(repetitiveOutput(3), 'pwsh'), undefined, 'unknown must keep the original')

  const allKeep = new ResultShaperService(
    () =>
      new TypeSafeClient({
        mockHandler: async () => ({
          keep_0: { type: 'noul', noul: 0.9 },
          keep_1: { type: 'noul', noul: 0.9 },
          keep_2: { type: 'noul', noul: 0.9 },
        }),
      }),
    {}
  )
  assert.equal(await allKeep.shape(repetitiveOutput(3), 'pwsh'), undefined)
})

test('apply shapes only eligible results and preserves the invariants', async () => {
  let calls = 0
  const h = harness(
    async () => {
      calls += 1
      return {
        keep_0: { type: 'noul', noul: 0.05 },
        keep_1: { type: 'noul', noul: 0.9 },
        keep_2: { type: 'noul', noul: 0.05 },
      }
    },
    { thresholdChars: 1000 }
  )

  const exec: ToolExecution = { name: 'pwsh', args: { command: 'build' } }
  const shaped = await h.step(exec, repetitiveOutput(3))
  assert.ok(shaped.content, 'eligible output must be replaced')
  assert.match(shaped.content!, /dropped by TypeSafe result shaper/)

  // An ineligible tool is left alone and costs nothing.
  const before = calls
  const untouched = await h.step({ name: 'read_file', args: {} }, repetitiveOutput(3))
  assert.equal(untouched.content, undefined)
  assert.equal(calls, before, 'ineligible tools must not trigger a decision')

  // The per-turn budget resets on a new instruction.
  h.preStep()
  const afterReset = await h.step(exec, repetitiveOutput(3).replace(/ok/g, 'ok2'))
  assert.ok(afterReset.content ?? true)
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
    { content: repetitiveOutput(3), isError: true },
    async () => ({ kind: 'accept', action: 'accept' })
  )
  assert.equal(failed.content, undefined)

  const rewritten = await postHandler(
    { name: 'pwsh', args: {} },
    { content: repetitiveOutput(3) },
    async () => ({ kind: 'accept', action: 'accept', content: 'downstream text' })
  )
  assert.equal(rewritten.content, 'downstream text')
})

test('apply stays silent when the decision call fails', async () => {
  const h = harness(async () => {
    throw new Error('api down')
  })
  const decision = await h.step({ name: 'pwsh', args: {} }, repetitiveOutput(3))
  assert.equal(decision.content, undefined)
  assert.equal(decision.kind, 'accept')
})

test('extractText reads both the string form and the block form the service uses', () => {
  assert.equal(extractText('plain text'), 'plain text')
  assert.equal(extractText([{ type: 'text', text: 'a' }, { type: 'image', url: 'x' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(extractText([{ type: 'image', url: 'x' }]), undefined, 'a non-text-only result has nothing to shape')
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
