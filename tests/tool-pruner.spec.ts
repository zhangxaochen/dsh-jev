import test from 'node:test'
import assert from 'node:assert/strict'
import { measureRemovedTools, ToolPrunerService } from '../lib/tool-pruner.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'
import type { ToolDefinitionMinimal } from '../lib/types.js'

test('ToolPrunerService prunes irrelevant tools and retains essential ones', async () => {
  const mockClient = new TypeSafeClient({
    mockHandler: async (req) => {
      // req.questions contains score_toolName
      return {
        score_grep_search: {
          type: 'score',
          score: 3,
          probabilities: { 1: 0, 2: 0.1, 3: 0.9 },
          confidence: 0.95,
        },
        score_git_commit: {
          type: 'score',
          score: 1,
          probabilities: { 1: 0.9, 2: 0.1, 3: 0 },
          confidence: 0.95,
        },
        score_weather_lookup: {
          type: 'score',
          score: 1,
          probabilities: { 1: 0.99, 2: 0.01, 3: 0 },
          confidence: 0.99,
        },
      }
    },
  })

  const candidates: ToolDefinitionMinimal[] = [
    { name: 'read_file', description: 'Read a file' }, // always retain
    { name: 'write_to_file', description: 'Write a file' }, // always retain
    { name: 'grep_search', description: 'Search text in files' },
    { name: 'git_commit', description: 'Create git commit' },
    { name: 'weather_lookup', description: 'Look up weather info' },
  ]

  const pruner = new ToolPrunerService(() => mockClient, {
    maxTools: 3,
    minScoreThreshold: 2,
    alwaysRetain: ['read_file', 'write_to_file'],
  })

  const pruned = await pruner.pruneTools('Search for function definition in source files', candidates)

  // Expected: read_file (alwaysRetain), write_to_file (alwaysRetain), grep_search (score 3)
  assert.equal(pruned.length, 3)
  const names = pruned.map((t) => t.name)
  assert.ok(names.includes('read_file'))
  assert.ok(names.includes('write_to_file'))
  assert.ok(names.includes('grep_search'))
  assert.ok(!names.includes('git_commit'))
  assert.ok(!names.includes('weather_lookup'))
})

test('ToolPrunerService bypasses pruning when candidates <= maxTools', async () => {
  const candidates: ToolDefinitionMinimal[] = [
    { name: 'tool_a' },
    { name: 'tool_b' },
  ]

  const pruner = new ToolPrunerService(
    () => {
      throw new Error('Should not be called')
    },
    { maxTools: 5 }
  )

  const result = await pruner.pruneTools('any intent', candidates)
  assert.equal(result.length, 2)
  assert.deepEqual(result, candidates)
})

test('ToolPrunerService emits survivors in their original order', async () => {
  // Scores deliberately disagree with the input order: the highest score is the
  // last candidate. Relevance decides membership, never position.
  const pruner = new ToolPrunerService(
    () =>
      new TypeSafeClient({
        // The late candidate scores highest, so score order and input order differ
        // among the survivors (minKeep 0 isolates ordering from the floor). With a tie the two orders coincide and the case
        // cannot tell them apart.
        mockHandler: async () => ({
          score_alpha: { type: 'score', score: 2, confidence: 0.5, probabilities: {} },
          score_mid: { type: 'score', score: 0.5, confidence: 0.9, probabilities: {} },
          score_zeta: { type: 'score', score: 2, confidence: 0.95, probabilities: {} },
          score_omega: { type: 'score', score: 0.5, confidence: 0.9, probabilities: {} },
        }),
      }),
    { maxTools: 3, minScoreThreshold: 2, alwaysRetain: [], minKeep: 0 }
  )

  const candidates: ToolDefinitionMinimal[] = [
    { name: 'alpha', description: 'first' },
    { name: 'mid', description: 'second' },
    { name: 'zeta', description: 'third' },
    { name: 'omega', description: 'fourth' },
  ]

  const result = await pruner.pruneTools('pick the two relevant tools', candidates)

  assert.deepEqual(
    result.map((tool) => tool.name),
    ['alpha', 'zeta'],
    'survivors must follow the input order, not the score order'
  )
})

test('ToolPrunerService keeps always-retained tools in place rather than hoisting them', async () => {
  const pruner = new ToolPrunerService(
    () =>
      new TypeSafeClient({
        mockHandler: async () => ({
          score_alpha: { type: 'score', score: 2, confidence: 0.9, probabilities: {} },
          score_beta: { type: 'score', score: 0.1, confidence: 0.9, probabilities: {} },
          score_gamma: { type: 'score', score: 2, confidence: 0.9, probabilities: {} },
        }),
      }),
    { maxTools: 3, minScoreThreshold: 2, alwaysRetain: ['beta'] }
  )

  const candidates: ToolDefinitionMinimal[] = [
    { name: 'alpha', description: 'a' },
    { name: 'beta', description: 'b' },
    { name: 'gamma', description: 'c' },
  ]

  const result = await pruner.pruneTools('any goal', candidates)
  assert.deepEqual(result.map((tool) => tool.name), ['alpha', 'beta', 'gamma'])
})

test('ToolPrunerService returns the very same array when nothing needs pruning', async () => {
  const pruner = new ToolPrunerService(
    () =>
      new TypeSafeClient({
        mockHandler: async () => {
          throw new Error('must not call the model when the candidate set already fits')
        },
      }),
    { maxTools: 5 }
  )

  const candidates: ToolDefinitionMinimal[] = [
    { name: 'a', description: 'a' },
    { name: 'b', description: 'b' },
  ]
  const result = await pruner.pruneTools('goal', candidates)
  assert.equal(result, candidates, 'a fitting candidate set must pass through untouched')
})

test('ToolPrunerService keeps a workable tool set when nothing reaches the threshold', async () => {
  // With the shipped threshold a multi-step intent can select a single tool, and a
  // deployment that narrows alwaysRetain can reach zero — the agent would then have
  // no way to act. The floor tops up from the best remaining candidates.
  // Every score is below the threshold of 2. Note the deliberate split: `extra1`
  // and `extra2` carry no answer at all, and an unanswered candidate counts as
  // "potentially useful" (score 1), so they outrank the ones scored 0.
  const allIrrelevant = async () => ({
    score_nothing: { type: 'score', score: 1, confidence: 0.9, probabilities: {} },
    score_more: { type: 'score', score: 1, confidence: 0.4, probabilities: {} },
    score_low: { type: 'score', score: 0, confidence: 0.9, probabilities: {} },
    score_zero: { type: 'score', score: 0, confidence: 0.9, probabilities: {} },
    score_extra1: { type: 'score', score: 0, confidence: 0.9, probabilities: {} },
    score_extra2: { type: 'score', score: 0, confidence: 0.9, probabilities: {} },
  })

  const floored = new ToolPrunerService(
    () => new TypeSafeClient({ mockHandler: allIrrelevant }),
    { maxTools: 4, minScoreThreshold: 2, alwaysRetain: [] }
  )
  const kept = await floored.pruneTools('do the thing', [
    { name: 'nothing', description: 'a' },
    { name: 'more', description: 'b' },
    { name: 'low', description: 'c' },
    { name: 'zero', description: 'd' },
    { name: 'extra1', description: 'e' },
    { name: 'extra2', description: 'f' },
  ])

  assert.deepEqual(
    kept.map((tool) => tool.name),
    ['nothing', 'more', 'low'],
    'the floor keeps three, in input order, even though none reached the threshold'
  )

  const strict = new ToolPrunerService(
    () => new TypeSafeClient({ mockHandler: allIrrelevant }),
    { maxTools: 4, minScoreThreshold: 2, alwaysRetain: [], minKeep: 0 }
  )
  assert.deepEqual(await strict.pruneTools('do the thing', [
    { name: 'nothing', description: 'a' },
    { name: 'more', description: 'b' },
    { name: 'low', description: 'c' },
    { name: 'zero', description: 'd' },
    { name: 'extra1', description: 'e' },
    { name: 'extra2', description: 'f' },
  ]), [], 'minKeep 0 restores the strict behaviour')
})

test('ToolPrunerService leaves the surface alone without a usable goal', async () => {
  // An empty goal gives the ranking nothing to work from. Measured behaviour with
  // an empty intent was unstable removal — the same list kept deploy_service for a
  // repository task and dropped run_tests — so pruning is skipped instead.
  let calls = 0
  const pruner = new ToolPrunerService(
    () =>
      new TypeSafeClient({
        mockHandler: async () => {
          calls += 1
          return { score_git_commit: { type: 'score', score: 2, confidence: 0.9, probabilities: {} } }
        },
      }),
    // minKeep 0 isolates the goal guard from the floor.
    { maxTools: 2, minScoreThreshold: 2, alwaysRetain: [], minKeep: 0 }
  )

  const candidates = [
    { name: 'git_commit', description: 'a' },
    { name: 'git_push', description: 'b' },
    { name: 'image_generate', description: 'c' },
  ]

  assert.deepEqual(await pruner.pruneTools('', candidates), candidates, 'an empty goal must not prune')
  assert.deepEqual(await pruner.pruneTools('   ', candidates), candidates, 'whitespace is not a goal')
  assert.equal(calls, 0, 'no request may be spent without a goal')

  const kept = await pruner.pruneTools('commit and push the staged changes', candidates)
  assert.deepEqual(kept.map((tool) => tool.name), ['git_commit'], 'a real goal still prunes')
  assert.equal(calls, 1)
})

test('measureRemovedTools prices through the meter and falls back when it refuses', () => {
  const pruned = [
    { name: 'a', description: 'first tool' },
    { name: 'b', description: 'second tool' },
  ]
  const expectedChars = pruned.reduce((total, tool) => total + Array.from(JSON.stringify(tool)).length, 0)

  // No meter: the documented local heuristic, reported as such.
  const heuristic = measureRemovedTools(undefined, pruned)
  assert.equal(heuristic.removedChars, expectedChars)
  assert.equal(heuristic.tokenSource, 'heuristic')
  assert.ok(heuristic.estimatedTokens > 0, 'a fallback estimate is still reported')

  // A working meter is preferred, and its numbers are the ones reported.
  const priced = measureRemovedTools({ estimateMessage: () => 42 }, pruned)
  assert.equal(priced.tokenSource, 'tokenMeter')
  assert.equal(priced.estimatedTokens, 42 * pruned.length)
  assert.equal(priced.removedChars, expectedChars, 'characters are counted locally either way')

  // A meter that throws, or returns something unusable, must not break the
  // accounting: the fallback covers it and the source says so.
  const refusing = measureRemovedTools(
    {
      estimateMessage: () => {
        throw new Error('unsupported shape')
      },
    },
    pruned
  )
  assert.equal(refusing.tokenSource, 'heuristic')
  assert.ok(refusing.estimatedTokens > 0)

  const nonsense = measureRemovedTools({ estimateMessage: () => Number.NaN }, pruned)
  assert.equal(nonsense.tokenSource, 'heuristic', 'a non-finite estimate is not a price')

  assert.deepEqual(measureRemovedTools(undefined, []), {
    removedChars: 0,
    estimatedTokens: 0,
    tokenSource: 'heuristic',
  })
})
