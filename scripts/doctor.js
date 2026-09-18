/**
 * Deployment doctor: is the running host actually using this build?
 *
 * Replacing files under a profile is not enough — the host mounts no HMR plugin,
 * so an already-running process keeps executing the build it imported at start.
 * That failure is silent: the old code keeps writing v1 metrics while the new
 * files sit on disk. This script makes the difference visible in one command.
 *
 * Usage:
 *   node scripts/doctor.js
 *   node scripts/doctor.js --json
 *
 * Exit codes: 0 = every check passed, 1 = attention needed.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findInstalledPluginDirs, resolveDshHome } from './sync-profiles.js'

/** Metrics schema written by the version that introduced measured fields. */
export const METRICS_SCHEMA_VERSION = 2

function hashFile(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return undefined
  }
}

/** Compare every built module between the repo and one installed copy. */
export function compareBuilds(repoRoot, installedDir) {
  const repoLib = join(repoRoot, 'lib')
  if (!existsSync(repoLib)) {
    return { checked: 0, mismatched: [], missing: [], ok: false }
  }
  const modules = readdirSync(repoLib).filter((name) => name.endsWith('.js'))
  const mismatched = []
  const missing = []
  for (const name of modules) {
    const installed = hashFile(join(installedDir, 'lib', name))
    if (installed === undefined) {
      missing.push(name)
      continue
    }
    if (installed !== hashFile(join(repoLib, name))) mismatched.push(name)
  }
  return { checked: modules.length, mismatched, missing, ok: mismatched.length === 0 && missing.length === 0 }
}

/**
 * Decide whether the running host has loaded a build that writes the measured
 * metrics schema.
 * @returns the verdict plus the raw facts behind it
 */
export function readRunningState(dshHome) {
  const file = join(dshHome, 'jev-stats.json')
  if (!existsSync(file)) {
    return { file, present: false, version: undefined, lastUpdatedAt: undefined, loadedMeasuredBuild: false }
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const version = typeof parsed?.version === 'number' ? parsed.version : undefined
    return {
      file,
      present: true,
      version,
      lastUpdatedAt: typeof parsed?.lastUpdatedAt === 'string' ? parsed.lastUpdatedAt : undefined,
      loadedMeasuredBuild: version === METRICS_SCHEMA_VERSION,
    }
  } catch {
    return { file, present: true, version: undefined, lastUpdatedAt: undefined, loadedMeasuredBuild: false }
  }
}

/** Full report over every profile that has the plugin installed. */
export function runDoctor({ repoRoot, dshHome }) {
  const installed = findInstalledPluginDirs(dshHome)
  const repoVersion = (() => {
    try {
      return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
    } catch {
      return undefined
    }
  })()

  const profiles = installed.map((entry) => {
    const builds = compareBuilds(repoRoot, entry.dir)
    let installedVersion
    try {
      installedVersion = JSON.parse(readFileSync(join(entry.dir, 'package.json'), 'utf8')).version
    } catch {
      installedVersion = undefined
    }
    // The profile manifest names an exact version, and the installed copy is
    // replaced in place, so the two drift. The declaration is what the next
    // `pnpm install` in that profile resolves - which any `dsh plugin add` runs -
    // so a stale one would silently replace the synced build with the old version.
    let declaredVersion
    try {
      const manifest = JSON.parse(readFileSync(join(dirname(dirname(entry.dir)), 'package.json'), 'utf8'))
      declaredVersion = manifest?.dependencies?.['dsh-jev']
    } catch {
      declaredVersion = undefined
    }
    return { profile: entry.profile, dir: entry.dir, installedVersion, declaredVersion, ...builds }
  })

  const running = readRunningState(dshHome)
  const copiesMatch = profiles.length > 0 && profiles.every((entry) => entry.ok)
  const versionsMatch = profiles.every((entry) => entry.installedVersion === repoVersion)
  const declaredMatch = profiles.every(
    (entry) => entry.declaredVersion === undefined || entry.declaredVersion === entry.installedVersion
  )

  return {
    repoVersion,
    profiles,
    running,
    verdict: {
      copiesMatch,
      versionsMatch,
      declaredMatch,
      restartRequired: copiesMatch && !running.loadedMeasuredBuild,
      ready: copiesMatch && versionsMatch && running.loadedMeasuredBuild,
    },
  }
}

function render(report) {
  const lines = []
  lines.push(`repo version: ${report.repoVersion ?? 'unknown'}`)

  if (report.profiles.length === 0) {
    lines.push('installed profiles: none — run `pnpm run sync` after installing the plugin')
  }
  for (const entry of report.profiles) {
    const state = entry.ok ? 'build in sync' : `MISMATCH (${entry.mismatched.length} changed, ${entry.missing.length} missing)`
    const declared =
      entry.declaredVersion !== undefined && entry.declaredVersion !== entry.installedVersion
        ? ` (manifest declares ${entry.declaredVersion})`
        : ''
    lines.push(`profile ${entry.profile}: version ${entry.installedVersion ?? 'unknown'}${declared} · ${state}`)
    for (const name of [...entry.mismatched, ...entry.missing]) lines.push(`  - ${name}`)
  }

  if (!report.running.present) {
    lines.push('running host: no metrics file yet (the plugin has not decided anything in this profile)')
  } else {
    lines.push(
      `running host: metrics schema v${report.running.version ?? 'unknown'} (last write ${report.running.lastUpdatedAt ?? 'unknown'})`
    )
  }

  const { copiesMatch, versionsMatch, restartRequired, ready } = report.verdict
  if (!copiesMatch) lines.push('ACTION: run `pnpm run sync` to copy the current build into every profile')
  if (!versionsMatch && copiesMatch) lines.push('ACTION: installed package.json differs from the repo version')
  if (restartRequired) {
    lines.push('ACTION: restart DSH. The files are current but the running process still uses the old build')
    lines.push('        (no HMR plugin is mounted, so replacing files cannot take effect in-process)')
  }
  if (ready) lines.push('OK: the running host is using the current build')

  return lines.join('\n')
}

function main() {
  const asJson = process.argv.includes('--json')
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const dshHome = resolveDshHome()
  const report = runDoctor({ repoRoot, dshHome })

  console.log(asJson ? JSON.stringify(report, null, 2) : render(report))
  process.exitCode = report.verdict.ready ? 0 : 1
}

if (process.argv[1] && process.argv[1].endsWith('doctor.js')) {
  main()
}
