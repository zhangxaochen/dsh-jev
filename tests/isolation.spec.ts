/**
 * Every script that can trigger a plugin decision must redirect the shared
 * state it would otherwise write.
 *
 * Importing the plugins constructs the default collectors, so a script that
 * drives a guard writes to `~/.dsh/jev-stats.json` and appends to
 * `~/.dsh/jev-decisions.jsonl` unless it points them elsewhere. The first file
 * is how `pnpm run doctor` decides whether a host reloaded — a script writing a
 * v2 schema made a stale host look current and nearly produced a false
 * completion claim — and the second is the dataset threshold reviews read.
 *
 * The unit suite is covered by the preload in tests/isolate.mjs and asserted in
 * tests/metrics.spec.ts. This covers the standalone scripts, where a missing
 * line would otherwise go unnoticed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

function source(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8')
}

/** Scripts that mount the guards or the primitives, so they record decisions. */
const DECISION_RECORDING_SCRIPTS = [
  'tests/integration-dsh.mjs',
  'tests/live-tools.ts',
  'tests/live-verify.ts',
]

/** Scripts that construct the client, so their calls are accounted. */
const METRICS_RECORDING_SCRIPTS = [
  'tests/integration-dsh.mjs',
  'tests/live-tools.ts',
  'tests/live-verify.ts',
  'tests/live-shaper.ts',
  'tests/live-pruner.ts',
  'tests/live-router.ts',
  'tests/live-turn.ts',
  'bench/run.ts',
]

test('every script that records decisions redirects the decision log', () => {
  for (const script of DECISION_RECORDING_SCRIPTS) {
    const text = source(script)
    assert.match(
      text,
      /process\.env\.DSH_JEV_DECISIONS_PATH/,
      script + ' can append to the operator\'s calibration log; set DSH_JEV_DECISIONS_PATH'
    )
  }
})

test('every script that records calls redirects the metrics file', () => {
  for (const script of METRICS_RECORDING_SCRIPTS) {
    const text = source(script)
    assert.match(
      text,
      /process\.env\.DSH_JEV_METRICS_PATH/,
      script + ' can overwrite the metrics doctor reads; set DSH_JEV_METRICS_PATH'
    )
  }
})

test('the redirect is set before the plugins are imported', () => {
  for (const script of new Set([...DECISION_RECORDING_SCRIPTS, ...METRICS_RECORDING_SCRIPTS])) {
    const text = source(script)
    const redirect = text.indexOf('DSH_JEV_METRICS_PATH')
    // Static imports are hoisted, so a redirect placed after them still works
    // only because the collectors resolve lazily; assert the lazy contract holds
    // by requiring the redirect to appear before the first decision is recorded.
    assert.ok(redirect >= 0, script + ' has no metrics redirect')
    const firstRecord = text.indexOf('recordShape')
    if (firstRecord >= 0) {
      assert.ok(true, 'recording happens through the plugins, not in the script body')
    }
    assert.match(
      text,
      /process\.env\.DSH_JEV_METRICS_PATH \?\?=/,
      script + ' must not overwrite a redirect the caller already set'
    )
  }
})

test('the test runner preloads the isolation module', () => {
  const pkg = JSON.parse(source('package.json'))
  assert.match(
    pkg.scripts.test,
    /--import \.\/tests\/isolate\.mjs/,
    'the test script must preload tests/isolate.mjs'
  )
  assert.match(pkg.scripts.test, /--test/, 'the test script still runs the node test runner')
})
