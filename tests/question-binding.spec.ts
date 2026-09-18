/**
 * Whenever a module asks N questions about N items, each item must travel inside
 * its own question.
 *
 * This is the lesson from the result shaper (docs/calibration.md §9.3): putting
 * the items in `state` and referring to them by index (`keep_3`, `kind_7`)
 * produced confident, identical answers for every question, because the model
 * cannot bind a question to an item it only sees as one entry in a list. The
 * modules that work — tool-pruner, skill-router — embed the item in the question
 * text itself.
 *
 * The assertions are behavioural rather than textual: the questions a module
 * builds must differ from one another, and each must carry its own item's
 * distinguishing text. A refactor that quietly drops the embedding fails here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerJevTools } from '../lib/ask-tools.js'
import { ResultShaperService } from '../lib/result-shaper.js'
import { SkillRouterService } from '../lib/skill-router.js'
import { ToolPrunerService } from '../lib/tool-pruner.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'
import type { CordisContext } from '../lib/types.js'

/** Capture the questions a module asks, and answer them. */
function captor(answer: (id: string, instruction: string) => unknown) {
  const requests: any[] = []
  const client = new TypeSafeClient({
    mockHandler: async (req) => {
      requests.push(req)
      const answers: Record<string, unknown> = {}
      for (const [id, question] of Object.entries(req.questions ?? {})) {
        answers[id] = answer(id, String((question as any).instructions ?? ''))
      }
      return answers
    },
  })
  return { client, requests, last: () => requests[requests.length - 1] }
}

/** Every question in a request must be distinguishable from the others. */
function assertQuestionsDiffer(questions: Record<string, any>, label: string) {
  const instructions = Object.values(questions).map((question: any) => String(question.instructions))
  assert.ok(instructions.length >= 2, label + ': expected at least two questions')
  assert.equal(
    new Set(instructions).size,
    instructions.length,
    label + ': two questions share identical instructions, so neither can be bound to its item'
  )
}

test('tool-pruner embeds each candidate tool in its own question', async () => {
  const { client, last } = captor(() => ({ type: 'score', score: 2, confidence: 0.9, probabilities: {} }))
  const pruner = new ToolPrunerService(() => client, { maxTools: 2, minScoreThreshold: 2, alwaysRetain: [] })

  await pruner.pruneTools('rank these tools', [
    { name: 'alpha_tool', description: 'does the alpha thing' },
    { name: 'beta_tool', description: 'does the beta thing' },
    { name: 'gamma_tool', description: 'does the gamma thing' },
  ])

  const questions = last().questions
  assertQuestionsDiffer(questions, 'tool-pruner')
  for (const name of ['alpha_tool', 'beta_tool', 'gamma_tool']) {
    assert.match(questions['score_' + name].instructions, new RegExp(name))
    assert.match(questions['score_' + name].instructions, new RegExp(name.split('_')[0]))
  }
  assert.match(questions.score_alpha_tool.instructions, /does the alpha thing/)
})

test('skill-router embeds each skill in its own question', async () => {
  const { client, last } = captor(() => ({ type: 'score', score: 2, confidence: 0.9, probabilities: {} }))
  const router = new SkillRouterService(() => client, {})

  await router.route('audit this diff for security problems', [
    { name: 'security-audit', description: 'reviews code for vulnerabilities' },
    { name: 'release-notes', description: 'writes release notes' },
  ])

  const questions = last().questions
  assertQuestionsDiffer(questions, 'skill-router')
  assert.match(questions['skill_security-audit'].instructions, /security-audit/)
  assert.match(questions['skill_security-audit'].instructions, /reviews code for vulnerabilities/)
  assert.match(questions['skill_release-notes'].instructions, /writes release notes/)
})

test('result-shaper embeds each line sample in its own question', async () => {
  const { client, last } = captor(() => ({ type: 'choice', choice: 'routine_progress', confidence: 0.99, probabilities: {} }))
  const shaper = new ResultShaperService(() => client, {})

  const content = ['progress: chunk 1 ok', 'progress: chunk 2 ok', 'ERROR in src/a.ts:42 TS2345'].join('\n')
  await shaper.shape(content, 'pwsh')

  const questions = last().questions
  assertQuestionsDiffer(questions, 'result-shaper')
  const instructions = Object.values(questions).map((question: any) => String(question.instructions))
  assert.ok(
    instructions.some((text) => text.includes('ERROR in src/a.ts:42 TS2345')),
    'the failing line must appear inside its own question'
  )
  assert.ok(
    instructions.some((text) => text.includes('progress: chunk 1 ok')),
    'the representative progress line must appear inside its own question'
  )
})

test('jev_rank embeds each candidate in its own question', async () => {
  const { client, last } = captor(() => ({ type: 'score', score: 1.5, confidence: 0.9, probabilities: {} }))
  const registered = new Map<string, any>()
  const ctx: CordisContext = {
    on: () => () => {},
    get: (name: string) =>
      name === 'tools'
        ? {
            register: (tool: any) => {
              registered.set(tool.name, tool)
              return () => registered.delete(tool.name)
            },
          }
        : undefined,
  }
  registerJevTools(ctx, () => client)

  await registered.get('jev_rank').execute({
    criterion: 'is most relevant to the task',
    candidates: [
      { id: 'a', label: 'Alpha', description: 'the alpha option' },
      { id: 'b', label: 'Beta', description: 'the beta option' },
    ],
  })

  const questions = last().questions
  assertQuestionsDiffer(questions, 'jev_rank')
  assert.match(questions.rank_a.instructions, /Alpha/)
  assert.match(questions.rank_a.instructions, /the alpha option/)
  assert.match(questions.rank_b.instructions, /the beta option/)
})
