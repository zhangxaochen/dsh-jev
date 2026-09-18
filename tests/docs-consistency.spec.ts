/**
 * The documentation must not claim a default the code does not use.
 *
 * Every numeric default named in README.md is read back out of the prose and
 * compared with the constant the module actually applies. A drift like the
 * `timeoutMs` value that said 10000 while the client used 2000 fails here
 * instead of silently misleading a reader who tunes their config.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PATH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from '../lib/typesafe-client.js'
import { cwd } from 'node:process'
import {
  DEFAULT_COOLDOWN_STEPS,
  DEFAULT_MAX_HISTORY,
  DEFAULT_MIN_CONFIDENCE as LOOP_MIN_CONFIDENCE,
  DEFAULT_NO_PROGRESS_THRESHOLD,
  DEFAULT_P_LOOP_THRESHOLD,
  DEFAULT_TRIGGER_THRESHOLD,
} from '../lib/loop-guard.js'
import {
  DEFAULT_ASK_APPROVAL_THRESHOLD,
  DEFAULT_BLOCK_THRESHOLD,
} from '../lib/safety-guard.js'
import { DEFAULT_MAX_TOOLS, DEFAULT_MIN_KEEP } from '../lib/tool-pruner.js'
import {
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_MIN_CANDIDATES,
  DEFAULT_MIN_CONFIDENCE as ROUTER_MIN_CONFIDENCE,
  DEFAULT_MIN_INTENT_CHARS,
  DEFAULT_MIN_SCORE,
  DEFAULT_NAME_MATCH_BOOST,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '../lib/skill-router.js'
import {
  DEFAULT_MAX_CLUSTERS,
  DEFAULT_MAX_PER_TURN,
  DEFAULT_MIN_KIND_CONFIDENCE,
  DEFAULT_SAMPLE_CHARS,
  DEFAULT_THRESHOLD_CHARS,
} from '../lib/result-shaper.js'

const README = readFileSync(join(process.cwd(), 'README.md'), 'utf8')

/**
 * Read the documented default for one config field.
 * @param field the option name as written in the README, e.g. `pLoopThreshold?: number`
 * @returns the number in the trailing 「默认 `x`」 clause
 */
function documentedDefault(field) {
  const line = README.split('\n').find((candidate) => candidate.startsWith('- `' + field))
  assert.ok(line, 'README does not document ' + field)
  const match = line.match(/默认\s*`([0-9.]+)`/)
  assert.ok(match, 'no default value stated for ' + field + ' in: ' + line)
  return Number(match[1])
}

test('README documents the client timeouts the code applies', () => {
  assert.equal(documentedDefault('timeoutMs?: number'), DEFAULT_TIMEOUT_MS)
  assert.ok(README.includes('`pathTimeoutMs?: number`'), 'README documents pathTimeoutMs')
  assert.equal(documentedDefault('pathTimeoutMs?: number'), DEFAULT_PATH_TIMEOUT_MS)
})

test('README documents the loop guard thresholds the code applies', () => {
  assert.equal(documentedDefault('triggerThreshold?: number'), DEFAULT_TRIGGER_THRESHOLD)
  assert.equal(documentedDefault('noProgressThreshold?: number'), DEFAULT_NO_PROGRESS_THRESHOLD)
  assert.equal(documentedDefault('pLoopThreshold?: number'), DEFAULT_P_LOOP_THRESHOLD)
  // Two `minConfidence` entries exist; the loop guard one is asserted by value.
  assert.ok(README.includes('（默认 `' + LOOP_MIN_CONFIDENCE + '`）'))
  assert.equal(documentedDefault('cooldownSteps?: number'), DEFAULT_COOLDOWN_STEPS)
  assert.equal(documentedDefault('maxHistory?: number'), DEFAULT_MAX_HISTORY)
})

test('README documents the safety guard thresholds the code applies', () => {
  assert.equal(documentedDefault('blockThreshold?: number'), DEFAULT_BLOCK_THRESHOLD)
  assert.equal(documentedDefault('askApprovalThreshold?: number'), DEFAULT_ASK_APPROVAL_THRESHOLD)
})

test('README documents the pruner, router and shaper defaults the code applies', () => {
  assert.equal(documentedDefault('maxTools?: number'), DEFAULT_MAX_TOOLS)
  assert.equal(documentedDefault('minCandidates?: number'), DEFAULT_MIN_CANDIDATES)
  assert.equal(documentedDefault('minIntentChars?: number'), DEFAULT_MIN_INTENT_CHARS)
  assert.equal(documentedDefault('minScore?: number'), DEFAULT_MIN_SCORE)
  assert.equal(documentedDefault('requestTimeoutMs?: number'), DEFAULT_REQUEST_TIMEOUT_MS)
  assert.equal(documentedDefault('nameMatchBoost?: number'), DEFAULT_NAME_MATCH_BOOST)
  assert.ok(README.includes('（默认 `' + ROUTER_MIN_CONFIDENCE + '`）'))
  assert.equal(documentedDefault('thresholdChars?: number'), DEFAULT_THRESHOLD_CHARS)
  assert.equal(documentedDefault('maxCandidates?: number'), DEFAULT_MAX_CANDIDATES)
  assert.equal(documentedDefault('minKeep?: number'), DEFAULT_MIN_KEEP)
  assert.equal(documentedDefault('maxPerTurn?: number'), DEFAULT_MAX_PER_TURN)
  assert.equal(documentedDefault('minKindConfidence?: number'), DEFAULT_MIN_KIND_CONFIDENCE)
  assert.equal(documentedDefault('maxClusters?: number'), DEFAULT_MAX_CLUSTERS)
  assert.equal(documentedDefault('sampleChars?: number'), DEFAULT_SAMPLE_CHARS)
})

test('the operationally important defaults are stated, not implied', () => {
  // These have no numeric default and must be spelled out instead.
  assert.match(README, /onError[^\n]*默认 `deny-guarded`/)
  assert.match(README, /onUncertain[^\n]*默认 `deny-guarded`/)
  assert.match(README, /deferExactRepeats[^\n]*默认 `true`/)
  assert.match(README, /resultShaper[^\n]*默认 \*\*关闭\*\*/)
})

test('docs/calibration.md threshold table matches the code it documents', () => {
  const calibration = readFileSync(join(process.cwd(), 'docs', 'calibration.md'), 'utf8')
  const documented = (key) => {
    const line = calibration.split('\n').find((candidate) => candidate.startsWith('| `' + key + '`'))
    assert.ok(line, 'calibration.md does not list ' + key)
    const match = line.match(/\|\s*([0-9.]+)\s*\|/)
    assert.ok(match, 'no value in the calibration row for ' + key)
    return Number(match[1])
  }

  assert.equal(documented('loopGuard.minConfidence'), LOOP_MIN_CONFIDENCE)
  assert.equal(documented('loopGuard.pLoopThreshold'), DEFAULT_P_LOOP_THRESHOLD)
  assert.equal(documented('loopGuard.maxHistory'), DEFAULT_MAX_HISTORY)
  assert.equal(documented('safetyGuard.blockThreshold'), DEFAULT_BLOCK_THRESHOLD)
  assert.equal(documented('safetyGuard.askApprovalThreshold'), DEFAULT_ASK_APPROVAL_THRESHOLD)
  assert.equal(documented('client.pathTimeoutMs'), DEFAULT_PATH_TIMEOUT_MS)
})

test('the documented unit-test count matches the suite', () => {
  // Writing a count into documentation is itself a defect class found earlier in
  // this work; the current-claim locations are guarded so adding tests fails the
  // build until the numbers are updated. Historical entries in the plan are a log
  // of each round and are deliberately not checked.
  const specFiles = readdirSync(join(cwd(), 'tests')).filter((name) => name.endsWith('.spec.ts'))
  let declared = 0
  for (const name of specFiles) {
    declared += (readFileSync(join(cwd(), 'tests', name), 'utf8').match(/^test\(/gm) ?? []).length
  }
  assert.ok(declared > 0, 'no test declarations found, so the count would be meaningless')

  const report = readFileSync(join(cwd(), 'docs', 'verification-report.md'), 'utf8')
  const reportClaim = report.match(/离线单测 \| \*\*(\d+)\/(\d+)\*\*/)
  assert.ok(reportClaim, 'the report must state the unit-test count')
  assert.equal(Number(reportClaim[1]), declared, 'verification-report.md unit-test count is stale')
  assert.equal(Number(reportClaim[2]), declared, 'the report states a mismatched pass count')

  const plan = readFileSync(join(cwd(), 'docs', 'OPTIMIZATION_PLAN.md'), 'utf8')
  const planClaim = plan.match(/合计 \*\*(\d+)\*\* 个离线单测/)
  assert.ok(planClaim, 'the plan summary must state the unit-test count')
  assert.equal(Number(planClaim[1]), declared, 'OPTIMIZATION_PLAN.md summary unit-test count is stale')
})

test('the integration script reports its own check count', () => {
  // The count cannot be derived statically (each section also carries a catch
  // guard), so the script prints it and the report points at that output.
  const script = readFileSync(join(cwd(), 'tests', 'integration-dsh.mjs'), 'utf8')
  assert.match(script, /checks passed: /, 'the integration script must print its check count')
  const report = readFileSync(join(cwd(), 'docs', 'verification-report.md'), 'utf8')
  assert.match(report, /pnpm run verify:dsh/, 'the report names the command that prints the count')
})

test('the research record cites sections and files that exist', () => {
  // The record maps borrowed practices onto evidence, so a stale citation would
  // point a reader at a section or file that no longer exists.
  const research = readFileSync(join(cwd(), 'docs', 'research.md'), 'utf8')
  const calibration = readFileSync(join(cwd(), 'docs', 'calibration.md'), 'utf8')

  const sections = [...research.matchAll(/§(\d+(?:\.\d+)?)/g)].map((match) => match[1])
  const uniqueSections = [...new Set(sections)]
  assert.ok(uniqueSections.length > 0, 'the record should cite the calibration sections it leans on')
  for (const section of uniqueSections) {
    const heading = new RegExp('(?:^|\\n)#+ *' + section.replace('.', '\\.') + '(?:\\.|\\s|$)')
    assert.ok(heading.test(calibration), 'research.md cites calibration §' + section + ', which has no such heading')
  }

  const files = [...research.matchAll(/`((?:tests|scripts|src|docs|bench)\/[A-Za-z0-9._/-]+)`/g)].map((match) => match[1])
  assert.ok(files.length > 0, 'the record should point at the files holding the evidence')
  for (const file of [...new Set(files)]) {
    assert.ok(existsSync(join(cwd(), file)), 'research.md points at ' + file + ', which does not exist')
  }
})

test('every config field the code accepts is documented', () => {
  // Keys added during this work (minKeep, minIntentChars, nameMatchBoost,
  // requestTimeoutMs, minKindConfidence ...) each had to be written into the
  // README by hand; five fields had already been missed, including
  // SafetyGuardConfig.headless, which changes whether a prompt is possible. The
  // check reads the interfaces rather than a list, so a new field cannot skip it.
  const types = readFileSync(join(cwd(), 'src', 'types.ts'), 'utf8')
  const readme = readFileSync(join(cwd(), 'README.md'), 'utf8')

  const interfaces = [...types.matchAll(/export interface (\w*Config\w*) \{([\s\S]*?)\n\}/g)]
  assert.ok(interfaces.length >= 5, 'expected the config interfaces to be found in src/types.ts')

  const missing = []
  for (const [, interfaceName, body] of interfaces) {
    for (const match of body.matchAll(/^\s{2}(\w+)\??:/gm)) {
      const field = match[1]
      if (!new RegExp('`' + field + '\\??:').test(readme)) missing.push(interfaceName + '.' + field)
    }
  }

  assert.deepEqual(missing, [], 'these config fields are accepted by the code but absent from README')
})

test('the changelog does not repeat a bullet inside one release section', () => {
  // A release note is read once, while upgrading; a bullet pasted twice makes the
  // section look like two changes where there is one. The 0.2.0 Changed section had
  // grown a duplicated pair.
  const changelog = readFileSync(join(cwd(), 'CHANGELOG.md'), 'utf8')
  const lines = changelog.split('\n')

  const duplicates = []
  let section = 'preamble'
  const seen = new Map()
  for (const line of lines) {
    const heading = line.match(/^#{2,3}\s+(.*)$/)
    if (heading) {
      section = heading[1].trim()
      seen.clear()
      continue
    }
    const bullet = line.match(/^-\s+(.*)$/)
    if (!bullet) continue
    // Compare the first line of the bullet; continuation lines follow it.
    const key = bullet[1].trim()
    if (seen.has(key)) duplicates.push(section + ': ' + key.slice(0, 60))
    else seen.set(key, true)
  }

  assert.deepEqual(duplicates, [], 'the changelog repeats these bullets')
})

test('every breaking change the README lists is announced in the changelog', () => {
  // The changelog is what people read while upgrading, so a breaking change that
  // only exists in the README's migration table is easy to miss. The markers are
  // deliberately the concepts, not the wording.
  const changelog = readFileSync(join(cwd(), 'CHANGELOG.md'), 'utf8')
  const markers = [
    ['removed stuckSeverityThreshold', /stuckSeverityThreshold/],
    ['the fail-closed default', /fail-closed/],
    ['the metrics schema change', /schema 升至 v2|version: 2|schema v2/],
  ]
  const missing = markers.filter(([, pattern]) => !pattern.test(changelog)).map(([label]) => label)
  assert.deepEqual(missing, [], 'these breaking changes are documented only in the README')
})

test('the evidence index names every gate the package exposes', () => {
  // The index is what a reviewer reads first, and it had drifted: two commands were
  // missing from the reproduce list, the drill count was three revisions old, and
  // neither corpus was mentioned at all - the strongest evidence for the pure
  // decision surfaces. Naming them here means a new gate has to be indexed.
  const report = readFileSync(join(cwd(), 'docs', 'verification-report.md'), 'utf8')
  const scripts = JSON.parse(readFileSync(join(cwd(), 'package.json'), 'utf8')).scripts

  const missing = []

  // The commands must appear in the reproduce block, not merely somewhere in the
  // prose: a row that mentions `pnpm run drill` while the runnable list omits it is
  // exactly the drift this guards.
  const block = report.match(/```bash\n([\s\S]*?)```/)
  assert.ok(block, 'the report needs a runnable reproduce block')
  const runnable = block![1]

  for (const name of Object.keys(scripts)) {
    const isGate = name.startsWith('verify:') || ['test', 'drill', 'bench:offline', 'typecheck:scripts'].includes(name)
    if (!isGate) continue
    const invocable = new RegExp('pnpm (?:run )?' + name.replace(':', '\\:') + '(?:\\s|$)')
    if (!invocable.test(runnable)) missing.push('script ' + name)
  }

  for (const file of readdirSync(join(cwd(), 'tests')).filter((name) => name.includes('corpus') && name.endsWith('.spec.ts'))) {
    if (!report.includes(file)) missing.push('corpus ' + file)
  }

  for (const file of readdirSync(join(cwd(), 'scripts')).filter((name) => name.endsWith('.mjs'))) {
    // `verify-build.mjs` is exposed as `verify:build`.
    const command = file.replace(/\.mjs$/, '').replace(/^verify-/, 'verify:')
    if (!report.includes(file) && !report.includes(command)) missing.push('script file ' + file)
  }

  assert.deepEqual(missing, [], 'the evidence index does not mention these gates')
})

test('the delivery summary counts each module as it stands', () => {
  // The summary is the first table a reader sees, and its per-module counts had
  // drifted: loop-guard said 10 against 13, safety-guard 9 against 11, tool-pruner 5
  // against 8, ask-tools 6 against 7, and the bench 30 against 36. The total was
  // gated; the breakdown was not.
  const plan = readFileSync(join(cwd(), 'docs', 'OPTIMIZATION_PLAN.md'), 'utf8')
  const summary = plan.slice(plan.indexOf('## 交付摘要'), plan.indexOf('## 基线'))

  const countTests = (file: string) =>
    (readFileSync(join(cwd(), 'tests', file), 'utf8').match(/^test\(/gm) ?? []).length

  // Each module maps to the specs that cover it; the client's failure behaviour is
  // asserted in the resilience spec, so those tests belong to it.
  const MODULES: Array<[string, string[], number]> = [
    ['typesafe-client', ['client.spec.ts', 'resilience.spec.ts'], 12],
    ['loop-guard', ['loop-guard.spec.ts'], 13],
    ['safety-guard', ['safety-guard.spec.ts'], 11],
    ['tool-pruner', ['tool-pruner.spec.ts'], 9],
    ['ask-tools', ['ask-tools.spec.ts'], 7],
    ['skill-router', ['skill-router.spec.ts'], 9],
    ['result-shaper', ['result-shaper.spec.ts'], 14],
  ]

  const wrong = []
  for (const [module, files, expected] of MODULES) {
    const actual = files.reduce((total, file) => total + countTests(file), 0)
    if (actual !== expected) wrong.push(module + ': the case expects ' + expected + ' but the specs hold ' + actual)

    const row = summary.split('\n').find((line) => line.startsWith('| `' + module + '`'))
    assert.ok(row, 'the summary must carry a row for ' + module)
    const claimed = Number(row!.match(/单测\s*(\d+)\s*项/)?.[1])
    assert.equal(claimed, actual, 'the summary claims a test count for ' + module + ' that the specs no longer hold')
  }
  assert.deepEqual(wrong, [], 'update the mapping and the summary together')
})

test('the reported drill and corpus sizes match the files', () => {
  // The index names the gates but not their sizes, so these drifted: the drill grew
  // from 21 to 23 entries and both corpora grew while the documents kept the old
  // numbers. Counts are read from the sources, never restated here.
  const report = readFileSync(join(cwd(), 'docs', 'verification-report.md'), 'utf8')
  const plan = readFileSync(join(cwd(), 'docs', 'OPTIMIZATION_PLAN.md'), 'utf8')

  const drill = readFileSync(join(cwd(), 'scripts', 'drill.mjs'), 'utf8')
  const drillBlock = drill.slice(drill.indexOf('const drills'), drill.indexOf('const results'))
  const drillEntries = (drillBlock.match(/name: '/g) ?? []).length
  assert.ok(drillEntries > 0, 'the drill must declare its entries')

  for (const [label, text] of [['verification-report.md', report]] as Array<[string, string]>) {
    for (const match of text.matchAll(/drill` \*\*(\d+)\/(\d+)\*\*/g)) {
      assert.equal(Number(match[1]), drillEntries, label + ' claims a drill total the script does not have')
      assert.equal(Number(match[2]), drillEntries, label + ' claims a drill pass count the script does not have')
    }
  }
  for (const match of report.matchAll(/`pnpm run drill`，(\d+) 条注入/g)) {
    assert.equal(Number(match[1]), drillEntries, 'the report claims a drill size the script does not have')
  }

  // Corpus sizes, as claimed in the report and the plan summary.
  // Count the case entries by their indentation: one corpus labels each case
  // `expect: 'deny' | 'pass'` and the other `expect: true | false`.
  const corpusSize = (file: string) => {
    const text = readFileSync(join(cwd(), 'tests', file), 'utf8')
    const block = text.slice(text.indexOf('const CASES'), text.indexOf('test('))
    return (block.match(/^ {2}\{/gm) ?? []).length
  }
  const envelope = corpusSize('deterministic-corpus.spec.ts')
  const precheck = corpusSize('repetition-corpus.spec.ts')

  for (const [label, text] of [['verification-report.md', report], ['OPTIMIZATION_PLAN.md', plan]] as Array<[string, string]>) {
    for (const match of text.matchAll(/deterministic-corpus\.spec\.ts`?[^|]{0,20}?\*{0,2}(\d+) 例/g)) {
      assert.equal(Number(match[1]), envelope, label + ' claims an envelope corpus size the file does not have')
    }
    for (const match of text.matchAll(/repetition-corpus\.spec\.ts`?[^|]{0,20}?(\d+) 例|16 例前置检查语料/g)) {
      if (match[1] === undefined) continue
      assert.equal(Number(match[1]), precheck, label + ' claims a pre-check corpus size the file does not have')
    }
  }
})

test('the documented host-acceptance size matches the script', () => {
  // The acceptance grew from six checks to seven when the key-resolution probe was
  // added; the count lives in three places, so it is read from the script instead.
  const script = readFileSync(join(cwd(), 'scripts', 'verify-host.mjs'), 'utf8')
  const body = script.slice(script.indexOf('export function buildAcceptance'), script.indexOf('const isDirectRun'))
  // The helper is declared as `check = (...)`, which this pattern does not match.
  const checks = (body.match(/\bcheck\(/g) ?? []).length
  assert.ok(checks >= 5, 'the acceptance should carry its checks in one builder')

  const report = readFileSync(join(cwd(), 'docs', 'verification-report.md'), 'utf8')
  const plan = readFileSync(join(cwd(), 'docs', 'OPTIMIZATION_PLAN.md'), 'utf8')

  const claimed = []
  for (const match of report.matchAll(/重启后期望 (\d+)\/(\d+)/g)) claimed.push(Number(match[1]))
  for (const match of plan.matchAll(/期望 exit 0、(\d+) 项全/g)) claimed.push(Number(match[1]))
  for (const match of plan.matchAll(/期望 (\d+)\/(\d+)、exit 0/g)) claimed.push(Number(match[1]))

  assert.ok(claimed.length >= 2, 'the pending action should state the acceptance size')
  for (const value of claimed) {
    assert.equal(value, checks, 'a documented acceptance size disagrees with the script')
  }
})

test('the documented rehearsal size matches the script', () => {
  // The whole-turn rehearsal grew from four checks to six when the call budget and
  // the key probe landed; its size is quoted in the index, so it is read from the
  // script. One of those checks had been added after the reporting loop, so it was
  // never printed and never counted until this round.
  const script = readFileSync(join(cwd(), 'tests', 'live-turn.ts'), 'utf8')
  const checks = (script.match(/^\s{2}check\(/gm) ?? []).length
  assert.ok(checks >= 5, 'the rehearsal should carry its checks explicitly')

  const report = readFileSync(join(cwd(), 'docs', 'verification-report.md'), 'utf8')
  const claimed = [...report.matchAll(/`verify:turn`[^\n]*?(\d+)\/(\d+)/g)]
  assert.ok(claimed.length >= 1, 'the index should quote the rehearsal size')
  for (const match of claimed) {
    assert.equal(Number(match[1]), checks, 'the documented rehearsal size disagrees with the script')
    assert.equal(Number(match[2]), checks, 'the documented rehearsal pass count disagrees with the script')
  }
})
