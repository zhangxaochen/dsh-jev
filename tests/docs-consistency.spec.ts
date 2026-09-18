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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PATH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from '../lib/typesafe-client.js'
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
import { DEFAULT_MAX_TOOLS } from '../lib/tool-pruner.js'
import {
  DEFAULT_MIN_CANDIDATES,
  DEFAULT_MIN_CONFIDENCE as ROUTER_MIN_CONFIDENCE,
  DEFAULT_MIN_INTENT_CHARS,
  DEFAULT_MIN_SCORE,
} from '../lib/skill-router.js'
import {
  DEFAULT_KEEP_THRESHOLD,
  DEFAULT_LINES_PER_SEGMENT,
  DEFAULT_MAX_PER_TURN,
  DEFAULT_MAX_SEGMENTS,
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
  assert.ok(README.includes('（默认 `' + ROUTER_MIN_CONFIDENCE + '`）'))
  assert.equal(documentedDefault('thresholdChars?: number'), DEFAULT_THRESHOLD_CHARS)
  assert.equal(documentedDefault('maxPerTurn?: number'), DEFAULT_MAX_PER_TURN)
  assert.equal(documentedDefault('linesPerSegment?: number'), DEFAULT_LINES_PER_SEGMENT)
  assert.equal(documentedDefault('maxSegments?: number'), DEFAULT_MAX_SEGMENTS)
  assert.equal(documentedDefault('keepThreshold?: number'), DEFAULT_KEEP_THRESHOLD)
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
