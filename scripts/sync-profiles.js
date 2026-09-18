/**
 * Copy the built plugin into every DSH profile that already has it installed.
 *
 * The previous script hardcoded one profile under USERPROFILE. A deployment can
 * mount the plugin in several profiles (desktop, web, headless, tui), and each
 * one loads its own copy, so syncing only one of them silently leaves the others
 * on the old build.
 *
 * Usage:
 *   node scripts/sync-profiles.js              # sync every profile that has dsh-jev
 *   node scripts/sync-profiles.js --dry-run    # list what would change, touch nothing
 *   node scripts/sync-profiles.js --profile web
 *
 * Note: DSH profiles in this deployment mount no HMR plugin, so a synced file is
 * only picked up after the host restarts. The script says so when it finishes.
 */

import { copyFileSync, cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_NAME = 'dsh-jev'

/** Resolve the DSH home the same way the host does. */
export function resolveDshHome(env = process.env) {
  if (env.DSH_HOME) return env.DSH_HOME
  const home = env.USERPROFILE ?? env.HOME ?? homedir()
  return join(home, '.dsh')
}

/**
 * Find every profile directory holding an installed copy of the plugin.
 * @param dshHome absolute DSH home
 * @returns absolute paths of the installed plugin directories
 */
export function findInstalledPluginDirs(dshHome) {
  const profilesDir = join(dshHome, 'profiles')
  if (!existsSync(profilesDir)) return []
  const found = []
  for (const entry of readdirSync(profilesDir)) {
    const candidate = join(profilesDir, entry, 'node_modules', PLUGIN_NAME)
    try {
      if (statSync(candidate).isDirectory()) found.push({ profile: entry, dir: candidate })
    } catch {
      /* not installed in this profile */
    }
  }
  return found
}

/** Files that make up the installed plugin. */
export function installPayload(repoRoot) {
  return {
    dirs: [{ from: join(repoRoot, 'lib'), to: 'lib' }],
    files: ['package.json', 'cordis.patch.yml', 'README.md'],
  }
}

/**
 * Align the profile's declared dependency with the version it was just given.
 *
 * The profile manifest names an exact version (`"dsh-jev": "0.1.0"`), and the
 * installed copy is replaced in place, so the two drift apart: the deployment
 * declares 0.1.0 while running 0.2.0 code. The next `pnpm install` in that profile
 * - which any `dsh plugin add` performs - would then resolve the declared version
 * and silently replace the synced build with the old one.
 *
 * @returns the version it was changed from, or undefined when nothing changed
 */
export function alignDeclaredVersion(profileDir, version) {
  const manifest = join(profileDir, 'package.json')
  if (!existsSync(manifest)) return undefined
  let parsed
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch {
    return undefined
  }
  const declared = parsed?.dependencies?.[PLUGIN_NAME]
  if (declared === undefined || declared === version) return undefined
  parsed.dependencies[PLUGIN_NAME] = version
  writeFileSync(manifest, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
  return declared
}

/**
 * Sync the repo build into the selected profiles.
 * @returns a per-profile report of what was written
 */
export function syncProfiles({ repoRoot, dshHome, profile, dryRun = false }) {
  const all = findInstalledPluginDirs(dshHome)
  const targets = profile ? all.filter((entry) => entry.profile === profile) : all
  const payload = installPayload(repoRoot)
  const report = []
  const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version

  for (const target of targets) {
    const written = []
    let realigned
    if (!dryRun) {
      for (const dir of payload.dirs) {
        cpSync(dir.from, join(target.dir, dir.to), { recursive: true, force: true })
        written.push(dir.to)
      }
      for (const file of payload.files) {
        const from = join(repoRoot, file)
        if (!existsSync(from)) continue
        copyFileSync(from, join(target.dir, file))
        written.push(file)
      }
      // <profile>/node_modules/dsh-jev -> the manifest lives two levels up.
      realigned = alignDeclaredVersion(dirname(dirname(target.dir)), version)
    }
    report.push({ profile: target.profile, dir: target.dir, written, dryRun, version, realigned })
  }

  return {
    dshHome,
    scanned: all.map((entry) => entry.profile),
    synced: report.map((entry) => entry.profile),
    skipped: profile ? all.filter((entry) => entry.profile !== profile).map((entry) => entry.profile) : [],
    report,
  }
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const profileIndex = args.indexOf('--profile')
  const profile = profileIndex >= 0 ? args[profileIndex + 1] : undefined

  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const dshHome = resolveDshHome()
  const result = syncProfiles({ repoRoot, dshHome, profile, dryRun })

  if (result.scanned.length === 0) {
    console.error(`No profile under ${dshHome} has ${PLUGIN_NAME} installed; nothing to do.`)
    process.exitCode = 1
    return
  }

  for (const entry of result.report) {
    const realigned = entry.realigned ? ` (declared version ${entry.realigned} -> ${entry.version})` : ''
    console.log(`${dryRun ? '[dry-run] ' : ''}${entry.profile}: ${entry.dir}${realigned}`)
  }
  if (result.skipped.length > 0) {
    console.log(`Skipped (not selected): ${result.skipped.join(', ')}`)
  }
  console.log(
    `\nSynced ${result.synced.length} profile(s). DSH mounts no HMR plugin here, so restart the host to load the new build.`
  )
}

if (process.argv[1] && process.argv[1].endsWith('sync-profiles.js')) {
  main()
}
