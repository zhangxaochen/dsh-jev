/**
 * Post-restart acceptance for the running host.
 *
 * Everything else in this repository is verified offline or against services
 * started in-process. The one thing no gate can cover is the host that is already
 * running: it keeps the build it loaded at startup, so a change only takes effect
 * after a restart, and "it should be fine now" is not evidence.
 *
 * Run this after restarting DSH. It exits 0 only when the running process is
 * demonstrably executing this build.
 *
 * Usage: pnpm run verify:host
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isTestEnvironment, TypeSafeClient } from '../lib/typesafe-client.js'
import { METRICS_SCHEMA_VERSION, runDoctor } from './doctor.js'

/**
 * Turn a doctor report and the live payload into the acceptance checks.
 *
 * Exported so the decision logic itself is gated: `tests/verify-host.spec.ts`
 * feeds it a v1 and a v2 report instead of the script only being exercised
 * against whatever the operator's machine happens to be running.
 */
export function buildAcceptance(report, payload, statsFile) {
  const checks = []
  const check = (label, ok, detail, remedy) => checks.push({ label, ok, detail, remedy })

  for (const profile of report.profiles) {
    const detail =
      profile.profile + ': ' + profile.installedVersion + ', ' + profile.checked + ' modules, ' +
      (profile.mismatched.length + profile.missing.length) + ' off'
    check(
      'profile ' + profile.profile + ' carries the current build',
      profile.ok,
      detail,
      'run `pnpm run sync` to copy the current build into every profile, then restart'
    )
  }

  check(
    'the shipped and installed versions agree',
    report.verdict.versionsMatch,
    report.repoVersion,
    'publish or sync the version before trusting the running host'
  )
  check(
    'the running host is executing this build',
    report.verdict.ready,
    report.verdict.restartRequired ? 'restart still required' : 'loaded',
    'restart the DSH desktop app; a running process keeps its startup build'
  )
  check(
    'the live metrics use schema v' + METRICS_SCHEMA_VERSION,
    report.running.version === METRICS_SCHEMA_VERSION,
    'live file reports v' + String(report.running.version),
    'the file is still written by the previous build; restart, then re-run this check'
  )

  const requiredSections = ['systemOne', 'toolPruner', 'loopGuard', 'safetyGuard', 'resultShaper']
  const present = requiredSections.filter((key) => payload && Object.hasOwn(payload, key))
  check(
    'the live payload carries every v2 section',
    present.length === requiredSections.length,
    present.join(',') || 'no payload',
    'restart; if the sections are still missing, the running build predates this schema'
  )

  // The plugin must be able to obtain its key without the host exporting it: the
  // shipped patch says `!!js process.env.TYPESAFE_API_KEY`, which yields undefined in
  // a host that never loads ~/.dsh/.env, and a plugin without a key fails every
  // decision silently.
  // Under a test runner the client deliberately refuses an ambient key, so probing
  // there would measure the isolation rather than the deployment.
  const keyProbeApplies = !isTestEnvironment()
  let keyResolved = !keyProbeApplies // inapplicable is not a failure
  let keyDetail = keyProbeApplies ? 'not checked' : 'not applicable under a test runner'
  // The stats file lives in the DSH home, so its directory is that home.
  const envFile = join(dirname(report.running.file), '.env')
  try {
    if (!keyProbeApplies) throw new Error('skipped')
    const fileHasKey = existsSync(envFile) && /TYPESAFE_API_KEY=\S/.test(readFileSync(envFile, 'utf8'))
    keyDetail = fileHasKey ? 'resolved from ' + envFile : 'no key in ' + envFile
    if (fileHasKey) {
      // A placeholder is what a host passes when it cannot evaluate the tag.
      const probe = new TypeSafeClient({ apiKey: '__jsExpr:process.env.TYPESAFE_API_KEY' })
      keyResolved = typeof probe.apiKey === 'string' && probe.apiKey.length > 0
      keyDetail = keyResolved ? 'resolved from ' + envFile : 'present in ' + envFile + ' but not picked up'
    }
  } catch (err) {
    if (keyProbeApplies) keyDetail = err instanceof Error ? err.message : String(err)
  }
  check(
    'the plugin can obtain an API key in a host that does not export it',
    keyResolved,
    keyDetail,
    'put TYPESAFE_API_KEY=... in ' + envFile + ', or export it in the host environment'
  )

  // Before the restart the running host predates this build by definition, so its
  // last write cannot be newer than the files; asserting freshness here would report
  // the expected state as a failure. Once it is running the build, the check applies.
  const installedBuild = report.profiles[0] ? join(report.profiles[0].dir, 'lib', 'index.js') : undefined
  let fresh = true
  let freshDetail = report.verdict.ready ? 'no installed build to compare' : 'not applicable before the restart'
  if (report.verdict.ready && installedBuild && existsSync(installedBuild) && statsFile && existsSync(statsFile)) {
    const buildAt = statSync(installedBuild).mtimeMs
    const statsAt = payload?.lastUpdatedAt ? Date.parse(payload.lastUpdatedAt) : statSync(statsFile).mtimeMs
    fresh = statsAt >= buildAt
    freshDetail = 'metrics ' + new Date(statsAt).toISOString() + ' vs build ' + new Date(buildAt).toISOString()
  }
  check(
    'the live numbers postdate the build they claim to measure',
    fresh,
    freshDetail,
    'the host has not recorded anything since the build changed; restart and use it once'
  )

  return checks
}
// The checks are exported for testing; the CLI must only run when this file is
// the entry point, or importing it would print a report and exit.
const isDirectRun = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url
if (isDirectRun) {
  const repoRoot = process.cwd()
  const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh')

  const report = runDoctor({ repoRoot, dshHome })
  const statsFile = report.running.file

  let payload
  try {
    payload = existsSync(statsFile) ? JSON.parse(readFileSync(statsFile, 'utf8')) : undefined
  } catch {
    payload = undefined
  }

  const checks = buildAcceptance(report, payload, statsFile)
  let failures = 0
  console.log('=== post-restart acceptance ===')
  console.log('repo ' + report.repoVersion + ' · schema v' + METRICS_SCHEMA_VERSION + ' · ' + statsFile + '\n')
  for (const entry of checks) {
    if (!entry.ok) failures += 1
    console.log((entry.ok ? 'ok   ' : 'FAIL ') + entry.label + (entry.detail ? '  (' + entry.detail + ')' : ''))
    if (!entry.ok && entry.remedy) console.log('       -> ' + entry.remedy)
  }

  console.log(
    failures === 0
      ? '\nthe running host is executing this build; the live metrics are its own.'
      : '\n' + failures + ' check(s) failed: the running host is not yet the build under test.'
  )
  process.exit(failures === 0 ? 0 : 1)
}