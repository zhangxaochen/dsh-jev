import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolPrunerService } from '../lib/tool-pruner.js'
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
        // among the survivors. With a tie the two orders coincide and the case
        // cannot tell them apart.
        mockHandler: async () => ({
          score_alpha: { type: 'score', score: 2, confidence: 0.5, probabilities: {} },
          score_mid: { type: 'score', score: 0.5, confidence: 0.9, probabilities: {} },
          score_zeta: { type: 'score', score: 2, confidence: 0.95, probabilities: {} },
          score_omega: { type: 'score', score: 0.5, confidence: 0.9, probabilities: {} },
        }),
      }),
    { maxTools: 3, minScoreThreshold: 2, alwaysRetain: [] }
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
