/**
 * Baseline probe: is the Jev ranking actually better than a lexical heuristic?
 *
 * Every ranking gate in this repository compares Jev against *nothing*. `bench` reports
 * 94.4% accuracy, `verify:pruner` 6/6 and `verify:router` 6 PASS + 1 KNOWN, but none of
 * them answers the question a reader asks first: would name-and-description keyword
 * matching have done as well, for zero calls and zero latency? A negative result from the
 * same family (Jev losing to a small dedicated model on retrieval reranking) is exactly
 * why this comparison is worth running.
 *
 * The lexical arm is deliberately a *reasonable* heuristic, not a strawman:
 *   tokenize: lowercase, split on non-alphanumeric, drop 1-char tokens and English
 *             stopwords, singularize a trailing `s` on words longer than 3 chars;
 *   score:    +6 when the intent contains the full name,
 *             +3 when any hyphen-part of the name (>=3 chars) appears as an intent token,
 *             +2 per name token shared with the intent,
 *             +1 per description token shared with the intent;
 *   rank:     score descending, ties keep catalogue order; the pruner keeps the top 4,
 *             the router picks the argmax.
 * The scheme was fixed before the run and is not tuned afterwards. It is not the strongest
 * possible lexical method (no IDF/BM25 weighting, no stemming beyond the trailing `s`, no
 * synonyms) - a stronger one would only strengthen the baseline, so treating this as a
 * lower bound on "lexical" is the honest reading.
 *
 * Run: node --experimental-strip-types tests/probe-baseline.ts
 * Writes docs/calibration/probe-<date>-baseline.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillRouterService } from '../lib/skill-router.js'
import { ToolPrunerService } from '../lib/tool-pruner.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'
import {
  loadSkillCatalog,
  PRUNER_CANDIDATES,
  PRUNER_CASES,
  PRUNER_MAX_TOOLS,
  ROUTER_CASES,
} from './ranking-cases.ts'

// Both arms drive the production services, so keep their accounting out of the operator's
// live metrics - the file `pnpm run doctor` reads to judge a deployment.
process.env.DSH_JEV_METRICS_PATH ??= join(tmpdir(), 'jev-probe-baseline-metrics.json')
process.env.DSH_JEV_DECISIONS_PATH ??= join(tmpdir(), 'jev-probe-baseline-decisions.jsonl')

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'with', 'this',
  'that', 'it', 'is', 'are', 'be', 'my', 'me', 'we', 'our', 'you', 'your', 'from', 'into',
  'then', 'than', 'as', 'by', 'up', 'out', 'do', 'does', 'does', 'what', 'which', 'who',
])

function tokenize(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map((token) => (token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token))
}

/** The lexical score described in the header; the only ranking the baseline has. */
function lexicalScore(name: string, description: string, intentTokens: string[], intentLower: string): number {
  const nameTokens = tokenize(name)
  const descriptionTokens = tokenize(description)
  let score = 0
  if (intentLower.includes(name.toLowerCase())) score += 6
  else if (name.split(/[-_]/).some((part) => part.length >= 3 && intentTokens.includes(part.toLowerCase()))) score += 3
  const intentSet = new Set(intentTokens)
  for (const token of nameTokens) if (intentSet.has(token)) score += 2
  for (const token of descriptionTokens) if (intentSet.has(token)) score += 1
  return score
}

function loadKey(): string {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY
  const envFile = join(homedir(), '.dsh', '.env')
  if (existsSync(envFile)) {
    const match = readFileSync(envFile, 'utf8').match(/TYPESAFE_API_KEY\s*=\s*(.+)/)
    if (match?.[1]) return match[1].trim()
  }
  throw new Error('TYPESAFE_API_KEY not found')
}

interface ArmResult {
  caseId: string
  ok: boolean
  picked: string[]
  problems: string[]
}

function judge(caseId: string, picked: string[], mustKeep: string[], mustDrop: string[]): ArmResult {
  const problems: string[] = []
  for (const required of mustKeep) if (!picked.includes(required)) problems.push('required dropped: ' + required)
  for (const forbidden of mustDrop) if (picked.includes(forbidden)) problems.push('irrelevant kept: ' + forbidden)
  return { caseId, ok: problems.length === 0, picked, problems }
}

async function main(): Promise<void> {
  const client = new TypeSafeClient({ apiKey: loadKey() })

  const prunerJev: ArmResult[] = []
  const prunerLexical: ArmResult[] = []
  const prunerLatency: number[] = []

  console.log('=== tool pruner: Jev vs lexical (maxTools = ' + PRUNER_MAX_TOOLS + ') ===')
  for (const testCase of PRUNER_CASES) {
    const pruner = new ToolPrunerService(() => client, {
      maxTools: PRUNER_MAX_TOOLS,
      minScoreThreshold: 1,
      alwaysRetain: [],
    })
    const started = Date.now()
    const selected = await pruner.pruneTools(testCase.intent, PRUNER_CANDIDATES)
    prunerLatency.push(Date.now() - started)
    prunerJev.push(judge(testCase.id, selected.map((tool) => tool.name), testCase.mustKeep, testCase.mustDrop))

    const intentTokens = tokenize(testCase.intent)
    const intentLower = testCase.intent.toLowerCase()
    const ranked = PRUNER_CANDIDATES.map((tool) => ({
      name: tool.name,
      score: lexicalScore(tool.name, tool.description ?? '', intentTokens, intentLower),
    }))
      .map((entry, index) => ({ ...entry, index }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, PRUNER_MAX_TOOLS)
      .map((entry) => entry.name)
    prunerLexical.push(judge(testCase.id, ranked, testCase.mustKeep, testCase.mustDrop))

    const jev = prunerJev[prunerJev.length - 1]
    const lex = prunerLexical[prunerLexical.length - 1]
    console.log(
      `[${testCase.id}] jev ${jev.ok ? 'PASS' : 'FAIL'} (${jev.picked.join(',')}) | ` +
        `lexical ${lex.ok ? 'PASS' : 'FAIL'} (${lex.picked.join(',')})`
    )
  }

  const catalog = await loadSkillCatalog()
  const routerJev: ArmResult[] = []
  const routerLexical: ArmResult[] = []
  const routerLatency: number[] = []
  const routerSkipped: string[] = []

  if (!catalog) {
    console.log('\nSKIP router arm: no DSH runtime found; set DSH_HOME to run it')
  } else {
    console.log('\n=== skill router: Jev vs lexical (catalog ' + catalog.length + ') ===')
    for (const testCase of ROUTER_CASES) {
      if (!catalog.some((skill: any) => testCase.expect.test(skill.name))) {
        routerSkipped.push(testCase.id)
        continue
      }

      const router = new SkillRouterService(() => client, {})
      const started = Date.now()
      const best = await router.route(testCase.intent, catalog)
      routerLatency.push(Date.now() - started)
      const pickedName = best?.name ?? '(none)'
      routerJev.push(judge(testCase.id, [pickedName], [], []))

      const intentTokens = tokenize(testCase.intent)
      const intentLower = testCase.intent.toLowerCase()
      const ranked = catalog
        .map((skill: any, index: number) => ({
          name: String(skill.name),
          score: lexicalScore(String(skill.name), String(skill.description ?? ''), intentTokens, intentLower),
          index,
        }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
      const lexicalName = ranked[0]?.name ?? '(none)'
      routerLexical.push(judge(testCase.id, [lexicalName], [], []))

      // `expect` is a pattern, so judging means matching the pattern - the same assertion
      // the live gate makes.
      const jevOk = testCase.expect.test(pickedName)
      const lexOk = testCase.expect.test(lexicalName)
      routerJev[routerJev.length - 1].ok = jevOk
      routerLexical[routerLexical.length - 1].ok = lexOk
      console.log(
        `[${testCase.id}] jev ${jevOk ? 'PASS' : testCase.knownMiss ? 'KNOWN' : 'FAIL'} (${pickedName}) | ` +
          `lexical ${lexOk ? 'PASS' : 'FAIL'} (${lexicalName})`
      )
    }
  }

  const summarize = (results: ArmResult[]) => ({
    cases: results.length,
    correct: results.filter((result) => result.ok).length,
    accuracy: results.length ? results.filter((result) => result.ok).length / results.length : undefined,
  })
  const mean = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : undefined)

  const report = {
    ranAt: new Date().toISOString(),
    lexicalScheme: {
      nameMention: 6,
      namePartMention: 3,
      nameTokenOverlap: 2,
      descriptionTokenOverlap: 1,
      tokenizer:
        'lowercase; split on non-alphanumeric; drop 1-char tokens and English stopwords; singularize a trailing s on words longer than 3 chars',
      caveats: [
        'no IDF/BM25 weighting',
        'no stemming beyond the trailing s',
        'no synonym table or bilingual mapping',
        'fixed before the run; not tuned afterwards',
      ],
    },
    pruner: {
      maxTools: PRUNER_MAX_TOOLS,
      jev: { ...summarize(prunerJev), latencyMeanMs: mean(prunerLatency), results: prunerJev },
      lexical: { ...summarize(prunerLexical), latencyMeanMs: 0, results: prunerLexical },
    },
    router: {
      catalogSize: catalog ? catalog.length : 0,
      skipped: routerSkipped,
      jev: { ...summarize(routerJev), latencyMeanMs: mean(routerLatency), results: routerJev },
      lexical: { ...summarize(routerLexical), latencyMeanMs: 0, results: routerLexical },
    },
  }

  const outDir = join(process.cwd(), 'docs', 'calibration')
  mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  const outFile = join(outDir, `probe-${stamp}-baseline.json`)
  writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8')

  console.log('\narm                 cases correct accuracy latency')
  for (const [label, arm] of [
    ['pruner/jev', report.pruner.jev],
    ['pruner/lexical', report.pruner.lexical],
    ['router/jev', report.router.jev],
    ['router/lexical', report.router.lexical],
  ] as const) {
    console.log(
      `${label.padEnd(18)} ${String(arm.cases).padStart(5)} ${String(arm.correct).padStart(7)} ` +
        `${((arm.accuracy ?? 0) * 100).toFixed(1).padStart(7)}% ${String(arm.latencyMeanMs ?? '-').padStart(6)}ms`
    )
  }
  console.log('\nwrote ' + outFile)
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    process.exit(1)
  }
)
