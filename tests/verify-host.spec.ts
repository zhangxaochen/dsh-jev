/**
 * The post-restart acceptance decision, exercised without a live host.
 *
 * `scripts/verify-host.mjs` is the only gate that can confirm the *running* process
 * is the build under test, and it is normally run against whatever the operator's
 * machine happens to be running. These cases feed it a fabricated report instead,
 * so the decision logic is covered on every machine.
 */
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { buildAcceptance } from '../scripts/verify-host.mjs'
import { METRICS_SCHEMA_VERSION } from '../scripts/doctor.js'

/**
 * A fabricated DSH home holding a key file, since the acceptance also checks that the
 * plugin can obtain a key without the host exporting one.
 */
const HOME = mkdtempSync(join(tmpdir(), 'jev-accept-'))
writeFileSync(join(HOME, '.env'), 'TYPESAFE_API_KEY=test-key\n', 'utf8')

/** A report shaped like `runDoctor`'s, with the running side under test. */
function report(overrides = {}) {
  return {
    repoVersion: '0.2.0',
    profiles: [
      {
        profile: 'desktop',
        dir: '/nowhere/dsh-jev',
        installedVersion: '0.2.0',
        checked: 13,
        mismatched: [],
        missing: [],
        ok: true,
      },
    ],
    running: {
      file: join(HOME, 'jev-stats.json'),
      present: true,
      version: METRICS_SCHEMA_VERSION,
      lastUpdatedAt: '2026-09-20T00:00:00.000Z',
      loadedMeasuredBuild: true,
    },
    verdict: { copiesMatch: true, versionsMatch: true, restartRequired: false, ready: true },
    ...overrides,
  }
}

const V2_PAYLOAD = {
  version: 2,
  systemOne: {},
  toolPruner: {},
  loopGuard: {},
  safetyGuard: {},
  resultShaper: {},
}

function failing(checks) {
  return checks.filter((entry) => !entry.ok).map((entry) => entry.label)
}

test('a host running the current build passes every acceptance check', () => {
  // No profile directory exists in this fixture, so the freshness check reports
  // "no installed build to compare" and stays neutral rather than failing.
  const checks = buildAcceptance(report(), V2_PAYLOAD, join(HOME, 'jev-stats.json'))
  assert.deepEqual(failing(checks), [], 'nothing should fail for a live v2 host')
  assert.ok(checks.length >= 5, 'the acceptance reports each claim separately')
})

test('a host still running the previous build fails the checks that matter', () => {
  const stale = report({
    running: {
      file: join(HOME, 'jev-stats.json'),
      present: true,
      version: 1,
      lastUpdatedAt: '2026-09-18T00:00:00.000Z',
      loadedMeasuredBuild: false,
    },
    verdict: { copiesMatch: true, versionsMatch: true, restartRequired: true, ready: false },
  })
  const v1Payload = { version: 1, systemOne: {}, toolPruner: {}, loopGuard: {}, safetyGuard: {} }

  const failures = failing(buildAcceptance(stale, v1Payload, join(HOME, 'jev-stats.json')))
  assert.deepEqual(failures, [
    'the running host is executing this build',
    'the live metrics use schema v' + METRICS_SCHEMA_VERSION,
    'the live payload carries every v2 section',
  ])
})

test('a profile that no longer matches the build fails on its own', () => {
  const drifted = report({
    profiles: [
      {
        profile: 'desktop',
        dir: '/nowhere/dsh-jev',
        installedVersion: '0.2.0',
        checked: 13,
        mismatched: ['tool-pruner.js'],
        missing: ['result-shaper.js'],
        ok: false,
      },
    ],
  })
  const failures = failing(buildAcceptance(drifted, V2_PAYLOAD, join(HOME, 'jev-stats.json')))
  assert.deepEqual(failures, ['profile desktop carries the current build'], 'a drifted copy must be named')
})

test('a version mismatch is reported before the running state is trusted', () => {
  const mismatched = report({
    verdict: { copiesMatch: true, versionsMatch: false, restartRequired: false, ready: true },
  })
  const failures = failing(buildAcceptance(mismatched, V2_PAYLOAD, join(HOME, 'jev-stats.json')))
  assert.deepEqual(failures, ['the shipped and installed versions agree'])
})

test('a missing payload is reported as such rather than parsed as empty', () => {
  const checks = buildAcceptance(report(), undefined, join(HOME, 'jev-stats.json'))
  const sections = checks.find((entry) => entry.label === 'the live payload carries every v2 section')
  assert.equal(sections?.ok, false)
  assert.equal(sections?.detail, 'no payload')
})
