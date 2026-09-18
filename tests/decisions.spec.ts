import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DecisionLog } from '../lib/decisions.js'

function tempLogPath(): string {
  return join(tmpdir(), 'jev-decisions-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jsonl')
}

test('DecisionLog appends records with a timestamp and reads them back', () => {
  const path = tempLogPath()
  const log = new DecisionLog(path)

  log.append({ module: 'loop-guard', action: 'pass', probability: 0.01, confidence: 0.98 })
  log.append({ module: 'loop-guard', action: 'warn', probability: 0.86, confidence: 0.77, latencyMs: 271 })
  log.append({ module: 'safety-guard', action: 'deny', probability: 0.98 })

  const records = log.read()
  assert.equal(records.length, 3)
  assert.ok(records.every((record) => typeof record.ts === 'string' && record.ts.includes('T')))
  assert.equal(records[1]?.latencyMs, 271)

  rmSync(path, { force: true })
})

test('DecisionLog skips an unparsable tail line instead of throwing', () => {
  const path = tempLogPath()
  const log = new DecisionLog(path)
  log.append({ module: 'safety-guard', action: 'ask', probability: 0.6 })
  appendFileSync(path, '{"module":"safety-guard","action":"de', 'utf8')

  const records = log.read()
  assert.equal(records.length, 1)
  assert.equal(records[0]?.action, 'ask')

  rmSync(path, { force: true })
})

test('DecisionLog summarizes counts and confidence per module and action', () => {
  const path = tempLogPath()
  const log = new DecisionLog(path)

  log.append({ module: 'loop-guard', action: 'pass', confidence: 0.9, probability: 0.01 })
  log.append({ module: 'loop-guard', action: 'pass', confidence: 0.7, probability: 0.02 })
  log.append({ module: 'loop-guard', action: 'warn', confidence: 0.8, probability: 0.86 })
  log.append({ module: 'safety-guard', action: 'hard-deny' })

  const summary = log.summarize()
  assert.equal(summary.total, 4)
  assert.equal(summary.byModule['loop-guard']?.pass, 2)
  assert.equal(summary.byModule['loop-guard']?.warn, 1)
  assert.equal(summary.byModule['safety-guard']?.['hard-deny'], 1)

  const passStats = summary.confidence['loop-guard:pass']
  assert.equal(passStats?.count, 2)
  assert.equal(passStats?.min, 0.7)
  assert.equal(passStats?.max, 0.9)
  assert.equal(passStats?.mean, 0.8)
  // A record without a confidence value must not skew the distribution.
  assert.equal(summary.confidence['safety-guard:hard-deny'], undefined)

  rmSync(path, { force: true })
})

test('DecisionLog is silent when the target is unwritable', () => {
  const log = new DecisionLog(join(tmpdir(), 'no-such-dir-' + Date.now(), 'nested', 'x.jsonl'))
  // Must not throw even though the parent cannot be created on a read-only host.
  log.append({ module: 'loop-guard', action: 'pass' })
  assert.ok(true)
})
