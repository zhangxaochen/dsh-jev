/**
 * Live smoke test for the agent-facing decision primitives.
 * Run: node --experimental-strip-types tests/live-tools.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { registerJevTools } from '../lib/ask-tools.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'
import type { CordisContext } from '../lib/types.js'

function loadKey(): string {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY
  const envFile = join(homedir(), '.dsh', '.env')
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/TYPESAFE_API_KEY\s*=\s*(.+)/)
    if (m?.[1]) return m[1].trim()
  }
  throw new Error('TYPESAFE_API_KEY not found')
}

const client = new TypeSafeClient({ apiKey: loadKey() })
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

async function main(): Promise<void> {
  console.log('=== decision primitives, live ===')

  const ask = await registered.get('jev_ask').execute({
    state: 'A pull request changes src/safety-guard.ts and adds tests; the diff is 240 lines.',
    questions: [
      { id: 'needs_review', kind: 'noul', instructions: 'Does this change warrant a careful human review?' },
      { id: 'risk', kind: 'score', instructions: 'How risky is this change?', criteria: ['low', 'medium', 'high'] },
      { id: 'area', kind: 'choice', instructions: 'Which area does it touch?', criteria: { guard: 'Safety guard', docs: 'Documentation', ci: 'CI config' } },
    ],
  })
  console.log('jev_ask:', JSON.stringify(ask.answers), ask.latencyMs + 'ms')

  const rank = await registered.get('jev_rank').execute({
    criterion: 'is most likely to contain the loop-detection threshold',
    candidates: [
      { id: 'a', label: 'README.md', description: 'user-facing documentation' },
      { id: 'b', label: 'src/loop-guard.ts', description: 'loop detection implementation' },
      { id: 'c', label: 'bench/cases.jsonl', description: 'labelled evaluation cases' },
    ],
  })
  console.log('jev_rank:', JSON.stringify(rank.ranked), rank.latencyMs + 'ms')

  const check = await registered.get('jev_check').execute({
    state: 'The suite reports: tests 50, pass 50, fail 0.',
    claim: 'every test passes',
  })
  console.log('jev_check:', JSON.stringify({ holds: check.holds, probability: check.probability }), check.latencyMs + 'ms')

  const suspicious = await registered.get('jev_check').execute({
    state: 'The diff deletes the fail-closed branch and always returns allow.',
    claim: 'the safety guard still fails closed on unknown verdicts',
  })
  console.log('jev_check (negative):', JSON.stringify({ holds: suspicious.holds, probability: suspicious.probability }))

  const ok = ask.answers.length === 3 && rank.ranked[0]?.id === 'b' && check.holds === true && suspicious.holds === false
  console.log(ok ? '\nAll primitives behaved as expected.' : '\nPrimitive expectations not met.')
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('live tools failed:', err)
  process.exit(1)
})
